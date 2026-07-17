/* ============================================================
   Cloudflare Pages Function — ENRIQUECER el catálogo con datos de Mercado Libre.

   Segundo paso del "Sincronizar con ProfitGuard": una sola pasada que, por cada
   SKU del catálogo, resuelve su publicación REAL en ML y guarda en el catálogo:
     - mlCatId        : id de categoría REAL de la publicación (fuente de verdad)
     - mlItemId       : id del ítem ML (MLC…)
     - mlPrice        : precio de venta actual en ML
     - mlCatNameReal / mlCatPathReal : nombre y breadcrumb de la categoría real
     - vel / velWeeks / velTeo / abc / stock : velocidad de venta REAL + clase ABC
   Así el Catálogo queda con la categoría correcta (y el cliente puede fijar la
   comisión desde su tabla local ya con la categoría corregida), y el análisis P2
   lee todo esto localmente sin volver a consultar nada.

   El filtro "category" del search de ítems de ML se ignora vía passthrough, por
   eso se listan TODOS los ítems activos del vendedor y se resuelve su category_id
   con multiget. Los nombres de categoría se cachean en KV (ml_cat_meta).

   Ruta: POST /api/catalog-ml   (?country=co no soportado aún)
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';
const ML_INTEGRATION_CL = 1;

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
  const url = new URL(request.url);
  if (url.searchParams.get('country') === 'co') return json({ error: 'Enriquecimiento ML aún solo para Chile' }, 501);
  const KEY = 'catalog';
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };

  try {
    const catalog = JSON.parse((await kv.get(KEY)) || '[]');
    if (!catalog.length) return json({ error: 'El catálogo está vacío; sincroniza primero con ProfitGuard.' }, 400);

    // Seller id del vendedor (por si cambia); fallback al ML User ID CL conocido.
    let seller = '613899966';
    try { const me = await mlGet(headers, '/users/me', {}); if (me && me.id) seller = String(me.id); } catch (e) {}

    // 1) Todos los ítems ACTIVOS del vendedor → sku → { cat, mlc, price, qty }.
    const ids = [];
    for (let off = 0; off < 2000; off += 100) {
      const b = await mlGet(headers, `/users/${seller}/items/search`, { status: 'active', offset: String(off), limit: '100' });
      const res = (b && b.results) || []; ids.push(...res);
      const total = (b && b.paging && b.paging.total) || 0;
      if (off + 100 >= total || !res.length) break;
    }
    // OJO: el SKU de PG NO siempre está en seller_custom_field (a veces null); casi
    // siempre está en el atributo SELLER_SKU. Y el GTIN = EAN. Indexamos por ambos SKUs
    // y por EAN para no perder productos (ej. MONPOR156 quedaba sin match antes).
    const bySku = {}, byEan = {};
    const put = (map, key, rec) => { if (!key || key === '-1') return; const cur = map[key]; if (!cur || (rec.qty || 0) > (cur.qty || 0)) map[key] = rec; };
    for (let i = 0; i < ids.length; i += 20) {
      const arr = await mlGet(headers, '/items', { ids: ids.slice(i, i + 20).join(','), attributes: 'id,category_id,price,seller_custom_field,available_quantity,status,attributes' });
      for (const w of (Array.isArray(arr) ? arr : [])) {
        const b = w && w.body; if (!b || b.status !== 'active') continue;
        const rec = { cat: b.category_id || '', mlc: b.id, price: b.price || null, qty: b.available_quantity || 0 };
        const scf = (b.seller_custom_field || '').trim();
        const ssku = (attrVal(b.attributes, 'SELLER_SKU') || '').trim();
        const ean = normEan(attrVal(b.attributes, 'GTIN'));
        put(bySku, scf, rec); put(bySku, ssku, rec);
        if (ean) put(byEan, ean, rec);
      }
    }

    // 2) Velocidad REAL + clase ABC + stock por SKU (sales_speed, todas las páginas).
    const spd = {};
    for (let page = 1; page <= 30; page++) {
      const j = await pgGet(headers, '/sales_speed/products', { week_count: '6', page: String(page), page_size: '100' });
      const its = (j && j.items) || [];
      const now = Date.now();
      for (const it of its) {
        const active = (it.weeklySales || []).filter(w => new Date(w.endDate).getTime() < now && (w.units || 0) > 0);
        spd[it.sku] = {
          vel: active.length ? Math.round(active.reduce((a, w) => a + (w.units || 0), 0) / active.length) : 0,
          velWeeks: active.length,
          velTeo: it.weeklySalesSpeed != null ? Math.round(it.weeklySalesSpeed) : null,
          abc: (it.category || '').toUpperCase() || null,
          stock: it.totalStock != null ? it.totalStock : null
        };
      }
      const tp = (j && j.meta && j.meta.total_pages) || 1;
      if (page >= tp) break;
    }

    // 2b) EAN por SKU (para el fallback de match por EAN cuando el SKU no calza).
    const eanBySku = {};
    for (let page = 1; page <= 30; page++) {
      const j = await pgGet(headers, '/products', { page: String(page), page_size: '100' });
      const arr = (j && (j.items || j.data)) || [];
      for (const p of arr) if (p && p.sku && p.ean) eanBySku[p.sku] = normEan(p.ean);
      const tp = (j && j.meta && j.meta.total_pages) || 1;
      if (page >= tp || !arr.length) break;
    }

    // 3) Nombre/breadcrumb de cada categoría distinta (público, cacheado en KV).
    const meta = JSON.parse((await kv.get('ml_cat_meta')) || '{}');
    const distinct = [...new Set([...Object.values(bySku), ...Object.values(byEan)].map(v => v.cat).filter(Boolean))];
    let metaNew = 0;
    for (const cid of distinct) {
      if (meta[cid]) continue;
      try {
        const c = await fetch('https://api.mercadolibre.com/categories/' + cid).then(r => r.ok ? r.json() : null);
        if (c) { meta[cid] = { name: c.name || '', path: (c.path_from_root || []).map(p => p.name) }; metaNew++; }
      } catch (e) {}
    }
    if (metaNew) await kv.put('ml_cat_meta', JSON.stringify(meta));

    // 4) Volcar todo al catálogo (match por SKU y, si falla, por EAN).
    let enriched = 0, withVel = 0, byEanCount = 0;
    for (const it of catalog) {
      const ean = eanBySku[it.sku] || normEan(it.ean);
      if (ean) it.ean = ean;
      let m = bySku[it.sku];
      if (!m && ean) { m = byEan[ean]; if (m) byEanCount++; }
      if (m) {
        it.mlCatId = m.cat; it.mlItemId = m.mlc; it.mlPrice = m.price;
        if (meta[m.cat]) { it.mlCatNameReal = meta[m.cat].name; it.mlCatPathReal = meta[m.cat].path; }
        enriched++;
      } else { it.mlCatId = it.mlCatId || ''; }
      const s = spd[it.sku];
      if (s) { it.vel = s.vel; it.velWeeks = s.velWeeks; it.velTeo = s.velTeo; it.abc = s.abc; it.stock = s.stock; withVel++; }
    }
    await kv.put(KEY, JSON.stringify(catalog));
    return json({ ok: true, total: catalog.length, enriched, withVel, byEan: byEanCount, cats: distinct.length, items: ids.length, metaNew });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

// Valor de un atributo de ML por id (ej. SELLER_SKU, GTIN).
function attrVal(attrs, id) {
  const a = (attrs || []).find(x => x && x.id === id);
  if (!a) return '';
  return a.value_name || (a.values && a.values[0] && a.values[0].name) || '';
}
// Normaliza EAN/GTIN: solo dígitos, sin ceros a la izquierda (ML a veces agrega uno).
function normEan(v) { const s = String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, ''); return s || ''; }

async function mlGet(headers, path, query) {
  const r = await fetch(`${PG}/integrations/${ML_INTEGRATION_CL}/passthrough`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path, query: query || {} })
  });
  if (!r.ok) throw new Error('ML passthrough ' + r.status);
  const j = await r.json().catch(() => null);
  return j && (j.body != null ? j.body : j);
}
async function pgGet(headers, path, query) {
  const qs = new URLSearchParams(query || {}).toString();
  const r = await fetch(`${PG}${path}${qs ? '?' + qs : ''}`, { headers });
  if (!r.ok) throw new Error('PG ' + path + ' ' + r.status);
  return r.json();
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
