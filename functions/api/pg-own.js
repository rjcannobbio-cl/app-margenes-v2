/* ============================================================
   Cloudflare Pages Function — catálogo PROPIO de ET Brands por categoría.

   Para que el análisis P2 sepa qué vende ya ET Brands en una categoría (marca
   propia correcta, costo y velocidad de venta real), busca en ProfitGuard los
   productos que matchean un término (derivado del nombre de la categoría hoja) y
   les agrega la velocidad semanal (sales_speed).

   Ruta: GET /api/pg-own?q=<término>   (?country=co no soportado aún)
   Devuelve { ok, brand, products:[{name,sku,brand,cost,ml,vel,avg,stock,active}], n }

   Usa el mismo secreto de PG que pg-sync (solo Chile por ahora).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('country') === 'co') return json({ error: 'Catálogo propio aún no configurado para Colombia' }, 501);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) return json({ ok: true, products: [], n: 0 });
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };

  try {
    // 1) Productos propios que matchean el término (nombre/sku/ean).
    const r = await fetch(`${PG}/products?query=${encodeURIComponent(q)}&page=1&page_size=25`, { headers });
    if (!r.ok) { const d = (await r.text().catch(() => '')).slice(0, 200); return json({ error: `ProfitGuard ${r.status}`, detail: d }, 502); }
    const j = await r.json();
    const items = j.items || j.data || [];
    // Compacta y prioriza activos con listing en Mercado Libre.
    let prods = items.map(p => ({
      name: (p.name || '').slice(0, 80),
      sku: p.sku || '',
      brand: (p.brand && p.brand.name) || '',
      cost: (p.unitCost && typeof p.unitCost.cents === 'number') ? Math.round(p.unitCost.cents / 100) : 0,
      ml: (p.externalProducts || []).some(e => e.integration && e.integration.id === 1),
      active: p.active !== false
    })).filter(p => p.sku);
    prods.sort((a, b) => (b.active - a.active) || (b.ml - a.ml));

    // 2) Velocidad de venta (weeklySalesSpeed) para los primeros activos (acota subrequests).
    const top = prods.filter(p => p.active).slice(0, 8);
    await Promise.all(top.map(async p => {
      try {
        const sr = await fetch(`${PG}/sales_speed/products?sku=${encodeURIComponent(p.sku)}&week_count=6`, { headers });
        if (!sr.ok) return;
        const sj = await sr.json();
        const it = (sj.items || [])[0]; if (!it) return;
        p.vel = it.weeklySalesSpeed || 0; p.avg = it.averageWeeklySales || 0; p.stock = it.totalStock || 0;
      } catch (e) {}
    }));

    // Marca dominante (la que más se repite entre activos).
    const bc = {}; for (const p of prods) if (p.active && p.brand) bc[p.brand] = (bc[p.brand] || 0) + 1;
    const brand = Object.keys(bc).sort((a, b) => bc[b] - bc[a])[0] || '';
    return json({ ok: true, brand, q, products: prods.slice(0, 20), n: prods.length });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
