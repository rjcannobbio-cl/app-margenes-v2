/* ============================================================
   Cloudflare Pages Function — catálogo PROPIO de ET Brands por categoría ML.

   El objetivo: dado el id de categoría hoja de ML (el mismo del P2), decir qué
   vende ya ET Brands EXACTAMENTE en esa categoría, con su marca real, precio,
   margen bruto, costo (COGS), costo FOB, clase ABC y velocidad de venta real.

   Cómo (y por qué así):
   - El REST /products de PG NO busca por texto ni por categoría; y el filtro
     "category" del search de ítems de ML se ignora vía passthrough. Por eso NO
     se puede matchear por nombre (frágil: "Bases"→"Bas"→"basura"...).
   - Solución: se indexan UNA vez los ítems activos del vendedor en ML con su
     category_id REAL (multiget) y se cachea en KV (refresco ~24h). Cada P2 solo
     filtra ese índice por su categoría → match preciso. El índice trae precio y
     SKU (seller_custom_field); el SKU se cruza con PG para costo/FOB/velocidad.

   Rutas (CL; ?country=co no soportado aún):
     GET /api/pg-own?build=1        → (re)construye el índice ML del vendedor en KV
     GET /api/pg-own?cat=<catId>    → productos propios en esa categoría (usa el índice)
       Si el índice no existe: { ok:true, products:[], n:0, needBuild:true }

   Usa el mismo secreto de PG que pg-sync (solo Chile por ahora).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';
const ML_INTEGRATION_CL = 1;
const ML_SELLER_CL = '613899966';
const IDX_KEY = 'ml_own_index';         // KV: { ts, seller, items:[{id,cat,sku,price,qty}] }
const IDX_TTL = 24 * 3600 * 1000;       // refrescar el índice cada 24h

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('country') === 'co') return json({ error: 'Catálogo propio aún no configurado para Colombia' }, 501);
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };

  try {
    // --- Construir/refrescar el índice ML del vendedor (llamada dedicada, acota subrequests). ---
    if (url.searchParams.get('build')) {
      const idx = await buildIndex(headers, kv);
      return json({ ok: true, n: idx.items.length, ts: idx.ts });
    }

    const cat = (url.searchParams.get('cat') || '').trim();
    if (!cat) return json({ error: 'falta cat (id de categoría ML)' }, 400);

    let idx = null;
    try { idx = JSON.parse((await kv.get(IDX_KEY)) || 'null'); } catch (e) {}
    if (!idx || !Array.isArray(idx.items)) return json({ ok: true, cat, products: [], n: 0, needBuild: true });
    const stale = !idx.ts || (Date.now() - idx.ts) > IDX_TTL;

    // Filtrar el índice por la categoría exacta y agrupar por SKU (un producto = varios listings).
    const hits = idx.items.filter(it => it.cat === cat);
    const bySku = new Map(); const noSku = [];
    for (const it of hits) {
      if (it.sku) {
        const cur = bySku.get(it.sku);
        // representativo: el listing con más stock disponible
        if (!cur || (it.qty || 0) > (cur.qty || 0)) bySku.set(it.sku, it);
      } else noSku.push(it);
    }

    const skus = [...bySku.keys()].slice(0, 16);
    // Enriquecer cada SKU con datos de PG (marca, COGS, FOB, velocidad real, clase ABC).
    const enriched = await Promise.all(skus.map(sku => enrichSku(headers, sku, bySku.get(sku))));
    // Ítems sin SKU en ML: se muestran con lo que hay (título/precio), sin datos de PG.
    for (const it of noSku.slice(0, 4)) enriched.push({
      name: (it.title || '').slice(0, 80), sku: '', brand: '', active: true,
      cost: 0, fob: null, abc: null, vel: null, velWeeks: 0, stock: it.qty != null ? it.qty : null,
      price: it.price || null, margin: null, ml: it.id
    });

    const products = enriched.filter(Boolean).sort((a, b) => (b.active - a.active) || ((b.vel || 0) - (a.vel || 0)));
    const bc = {}; for (const p of products) if (p.active && p.brand) bc[p.brand] = (bc[p.brand] || 0) + 1;
    const brand = Object.keys(bc).sort((a, b) => bc[b] - bc[a])[0] || '';
    return json({ ok: true, cat, brand, products, n: products.length, ts: idx.ts, stale });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

// Trae todos los ítems ACTIVOS del vendedor con su category_id real y los cachea.
async function buildIndex(headers, kv) {
  const ids = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const body = await mlGet(headers, `/users/${ML_SELLER_CL}/items/search`, { status: 'active', offset: String(offset), limit: '100' });
    const res = (body && body.results) || [];
    ids.push(...res);
    const total = body && body.paging && body.paging.total || 0;
    if (offset + 100 >= total || !res.length) break;
  }
  const items = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const arr = await mlGet(headers, '/items', { ids: chunk.join(','), attributes: 'id,category_id,price,seller_custom_field,available_quantity,status' });
    for (const w of (Array.isArray(arr) ? arr : [])) {
      const b = w && w.body; if (!b || b.status !== 'active') continue;
      items.push({ id: b.id, cat: b.category_id || '', sku: (b.seller_custom_field || '').trim(), price: b.price || null, qty: typeof b.available_quantity === 'number' ? b.available_quantity : null });
    }
  }
  const idx = { ts: Date.now(), seller: ML_SELLER_CL, items };
  await kv.put(IDX_KEY, JSON.stringify(idx));
  return idx;
}

// Enriquece un SKU con datos de PG y calcula el margen bruto con el precio ML.
async function enrichSku(headers, sku, mlItem) {
  const row = {
    name: sku, sku, brand: '', active: true, cost: 0, fob: null, abc: null,
    vel: null, velWeeks: 0, stock: null, price: (mlItem && mlItem.price) || null, margin: null, ml: (mlItem && mlItem.id) || null
  };
  // Producto PG (marca, COGS, id). El REST /products sí filtra por sku exacto.
  let pid = null;
  try {
    const pj = await pgGet(headers, '/products', { sku, page_size: '5' });
    const it = ((pj && (pj.items || pj.data)) || []).find(p => (p.sku || '') === sku);
    if (it) {
      pid = it.id;
      row.name = (it.name || sku).slice(0, 80);
      row.brand = (it.brand && it.brand.name) || '';
      row.active = it.active !== false;
      row.cost = (it.unitCost && typeof it.unitCost.cents === 'number') ? Math.round(it.unitCost.cents / 100) : 0;
    }
  } catch (e) {}
  await Promise.all([
    (async () => {
      try {
        const sr = await pgGet(headers, '/sales_speed/products', { sku, week_count: '6' });
        const it = ((sr && sr.items) || [])[0]; if (!it) return;
        row.velTeo = it.weeklySalesSpeed != null ? Math.round(it.weeklySalesSpeed) : null;
        row.stock = it.totalStock != null ? it.totalStock : row.stock;
        row.abc = (it.category || '').toUpperCase() || null;
        // Velocidad REAL: promedio de semanas completas CON ventas (proxy de "con stock").
        const now = Date.now();
        const active = (it.weeklySales || []).filter(w => new Date(w.endDate).getTime() < now && (w.units || 0) > 0);
        row.velWeeks = active.length;
        row.vel = active.length ? Math.round(active.reduce((a, w) => a + (w.units || 0), 0) / active.length) : 0;
      } catch (e) {}
    })(),
    (async () => {
      if (!pid) return;
      try {
        const fr = await pgGet(headers, '/product_sourcings', { product_id: String(pid), page_size: '5' });
        const it = ((fr && fr.items) || [])[0]; if (!it || !it.unitCost) return;
        row.fob = Math.round((it.unitCost.cents || 0) / 100);   // USD
      } catch (e) {}
    })()
  ]);
  // Margen bruto: precio neto de IVA vs COGS (antes de comisión/envío/ads).
  if (row.price && row.cost > 0) { const net = row.price / 1.19; row.margin = Math.round((net - row.cost) / net * 100); }
  return row;
}

// GET a ML vía passthrough de PG (devuelve el body de ML).
async function mlGet(headers, path, query) {
  const r = await fetch(`${PG}/integrations/${ML_INTEGRATION_CL}/passthrough`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path, query: query || {} })
  });
  if (!r.ok) throw new Error('ML passthrough ' + r.status);
  const j = await r.json().catch(() => null);
  return j && (j.body != null ? j.body : j);
}

// GET al REST de PG.
async function pgGet(headers, path, query) {
  const qs = new URLSearchParams(query || {}).toString();
  const r = await fetch(`${PG}${path}${qs ? '?' + qs : ''}`, { headers });
  if (!r.ok) throw new Error('PG ' + path + ' ' + r.status);
  return r.json();
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
