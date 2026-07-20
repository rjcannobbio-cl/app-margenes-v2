/* ============================================================
   Cloudflare Pages Function — Seguimiento de productos NUEVOS (categoría D).

   Fase 1: lista los productos categoría D de ProfitGuard (con su serie semanal de
   unidades para calcular velocidad real, Maduro y Cumple-velocidad) y guarda la
   META editable por el usuario (velocidad madura, fecha 1ª venta, velocidad
   inicial) + import desde Excel. Los financieros (ventas/margen/TACOS) y visitas
   ML se agregan en fases siguientes (get_sales_speed_product + passthrough).

   Rutas (CL; ?country=co no soportado aún):
     GET  /api/track                      → { products:{ts,items}, meta }
     POST /api/track {action:'refreshProducts'}   → re-lee los productos D de PG
     POST /api/track {action:'meta', sku, patch}  → edita meta de un SKU
     POST /api/track {action:'import', rows}       → carga meta masiva (Excel)

   KV: track_products = {ts, items:[{id,sku,name,kit,avgWeekly,weeks:[{s,e,u}]}]}
       track_meta     = {sku:{firstSale,velMadura,velInicial}}
   Usa el mismo secret de PG que pg-sync (solo Chile).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const url = new URL(request.url);
  if (url.searchParams.get('country') === 'co') return json({ error: 'Seguimiento aún solo para Chile' }, 501);
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };

  try {
    if (request.method === 'GET') {
      const products = JSON.parse((await kv.get('track_products')) || 'null');
      const meta = JSON.parse((await kv.get('track_meta')) || '{}');
      return json({ products, meta });
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const action = body && body.action;

      if (action === 'meta') {
        if (!body.sku) return json({ error: 'falta sku' }, 400);
        const meta = JSON.parse((await kv.get('track_meta')) || '{}');
        meta[body.sku] = Object.assign({}, meta[body.sku], body.patch || {});
        await kv.put('track_meta', JSON.stringify(meta));
        return json({ ok: true });
      }

      if (action === 'import') {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const meta = JSON.parse((await kv.get('track_meta')) || '{}');
        let n = 0;
        for (const r of rows) {
          const sku = (r.sku || '').toString().trim(); if (!sku) continue;
          const cur = meta[sku] || {};
          if (r.velMadura != null && r.velMadura !== '') cur.velMadura = +r.velMadura;
          if (r.firstSale) cur.firstSale = String(r.firstSale).slice(0, 10);
          if (r.velInicial != null && r.velInicial !== '') cur.velInicial = +r.velInicial;
          meta[sku] = cur; n++;
        }
        await kv.put('track_meta', JSON.stringify(meta));
        return json({ ok: true, imported: n });
      }

      if (action === 'refreshProducts') {
        if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
        const items = [];
        for (let page = 1; page <= 20; page++) {
          const r = await fetch(`${PG}/sales_speed/products?category=d&week_count=30&page=${page}&page_size=100`, { headers });
          if (!r.ok) { if (page === 1) return json({ error: `ProfitGuard ${r.status}` }, 502); break; }
          const j = await r.json();
          for (const it of (j.items || [])) {
            if (String(it.category || '').toLowerCase() !== 'd') continue;   // solo clase D (guard defensivo)
            if (it.kit) continue;                                            // excluir KITS (deben ser NO kit)
            items.push({
              id: it.id, sku: it.sku, name: (it.name || '').slice(0, 90), kit: !!it.kit, category: it.category || '',
              avgWeekly: it.averageWeeklySales != null ? it.averageWeeklySales : null,
              weeks: (it.weeklySales || []).map(w => ({ s: w.startDate, e: w.endDate, u: w.units || 0, n: w.number }))
            });
          }
          const tp = (j.meta && j.meta.total_pages) || 1; if (page >= tp) break;
        }
        const out = { ts: Date.now(), items };
        await kv.put('track_products', JSON.stringify(out));
        return json({ ok: true, count: items.length, ts: out.ts });
      }

      return json({ error: 'acción no soportada' }, 400);
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
