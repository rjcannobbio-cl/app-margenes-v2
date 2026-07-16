/* ============================================================
   Cloudflare Pages Function — catálogo PROPIO de ET Brands por categoría.

   Para que el análisis P2 sepa qué vende ya ET Brands en una categoría (marca
   propia REAL, costo, costo FOB, clase ABC y velocidad de venta REAL de las
   últimas semanas), busca en ProfitGuard los productos cuyo NOMBRE matchea el
   término (derivado del nombre de la categoría hoja) y los enriquece.

   OJO: el REST /products NO soporta búsqueda por texto (solo brand_id/sku/page).
   Por eso traemos el catálogo paginado y filtramos por nombre en la Function.

   Ruta: GET /api/pg-own?q=<término>   (?country=co no soportado aún)
   Devuelve { ok, brand, q, products:[{name,sku,brand,active,cost,fob,abc,vel,velTeo,stock}], n }
     - cost  = COGS en CLP (costo puesto en bodega)
     - fob   = costo FOB en USD (sourcing) | null
     - abc   = clase A/B/C/D/F (top rotación → cola) | null
     - vel   = velocidad REAL (promedio de las semanas completas CON ventas) | null
     - velWeeks = nº de semanas con ventas usadas para el promedio
     - velTeo= velocidad teórica precalculada por PG (referencia) | null
     - stock = stock total

   Usa el mismo secreto de PG que pg-sync (solo Chile por ahora).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
function norm(s) { return (s == null ? '' : String(s)).toLowerCase().normalize('NFD').replace(DIACRITICS, ''); }

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('country') === 'co') return json({ error: 'Catálogo propio aún no configurado para Colombia' }, 501);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) return json({ ok: true, products: [], n: 0 });
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  const nq = norm(q);

  try {
    // 1) Traer el catálogo COMPLETO (paginado en paralelo) — el REST no filtra por texto.
    const first = await fetch(`${PG}/products?page=1&page_size=100`, { headers });
    if (!first.ok) { const d = (await first.text().catch(() => '')).slice(0, 200); return json({ error: `ProfitGuard ${first.status}`, detail: d }, 502); }
    const fj = await first.json();
    let all = fj.items || fj.data || [];
    const totalPages = Math.min((fj.meta && fj.meta.total_pages) || 1, 15);
    if (totalPages > 1) {
      const rest = await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) =>
        fetch(`${PG}/products?page=${i + 2}&page_size=100`, { headers }).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }))));
      for (const p of rest) all = all.concat(p.items || p.data || []);
    }

    // 2) Filtrar por NOMBRE que contiene el término (acento/caso-insensible) y acotar.
    let matched = all.filter(p => norm(p.name).includes(nq));
    matched.sort((a, b) => ((b.active !== false) - (a.active !== false)));
    matched = matched.slice(0, 16);

    // 3) Enriquecer cada match: velocidad REAL (sales_speed) + FOB (sourcing).
    const products = await Promise.all(matched.map(async p => {
      const cost = (p.unitCost && typeof p.unitCost.cents === 'number') ? Math.round(p.unitCost.cents / 100) : 0;
      const row = {
        name: (p.name || '').slice(0, 80), sku: p.sku || '', brand: (p.brand && p.brand.name) || '',
        active: p.active !== false, cost, fob: null, abc: null, vel: null, velTeo: null, stock: null
      };
      await Promise.all([
        (async () => {
          if (!p.sku) return;
          try {
            const sr = await fetch(`${PG}/sales_speed/products?sku=${encodeURIComponent(p.sku)}&week_count=6`, { headers });
            if (!sr.ok) return;
            const it = ((await sr.json()).items || [])[0]; if (!it) return;
            row.velTeo = it.weeklySalesSpeed != null ? Math.round(it.weeklySalesSpeed) : null;
            row.stock = it.totalStock != null ? it.totalStock : null;
            row.abc = (it.category || '').toUpperCase() || null;
            // Velocidad REAL: promedio SOLO de las semanas completas en que hubo ventas
            // (proxy de "semanas con stock"), excluyendo la parcial en curso. PG no expone
            // el stock histórico por semana, así que una semana con 0 ventas se asume quiebre.
            const now = Date.now();
            const done = (it.weeklySales || []).filter(w => new Date(w.endDate).getTime() < now);
            const active = done.filter(w => (w.units || 0) > 0);
            row.velWeeks = active.length;
            row.vel = active.length ? Math.round(active.reduce((a, w) => a + (w.units || 0), 0) / active.length) : 0;
          } catch (e) {}
        })(),
        (async () => {
          if (!p.id) return;
          try {
            const fr = await fetch(`${PG}/product_sourcings?product_id=${p.id}&page_size=5`, { headers });
            if (!fr.ok) return;
            const it = ((await fr.json()).items || [])[0]; if (!it || !it.unitCost) return;
            row.fob = Math.round((it.unitCost.cents || 0) / 100);   // USD (costo FOB)
          } catch (e) {}
        })()
      ]);
      return row;
    }));

    // Marca dominante entre los activos (para el encabezado).
    const bc = {}; for (const p of products) if (p.active && p.brand) bc[p.brand] = (bc[p.brand] || 0) + 1;
    const brand = Object.keys(bc).sort((a, b) => bc[b] - bc[a])[0] || '';
    return json({ ok: true, brand, q, products, n: products.length });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
