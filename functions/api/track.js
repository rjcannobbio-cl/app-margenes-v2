/* ============================================================
   Cloudflare Pages Function — Seguimiento de productos NUEVOS (categoría D).

   Fase 1: lista los productos categoría D de ProfitGuard (con su serie semanal de
   unidades para calcular velocidad real, Maduro y Cumple-velocidad) y guarda la
   META editable por el usuario (velocidad madura, fecha 1ª venta, velocidad
   inicial) + import desde Excel. Los financieros (ventas/margen/TACOS) y visitas
   ML se agregan en fases siguientes (get_sales_speed_product + passthrough).

   Rutas (CL; ?country=co no soportado aún):
     GET  /api/track                      → { products:{ts,items}, meta, metrics }
     POST /api/track {action:'refreshProducts'}   → re-lee los productos D de PG (excluye kits)
     POST /api/track {action:'refreshMetrics', offset, limit}  → Fase 2: financieros por lote (get_sales_speed_product)
     POST /api/track {action:'refreshVisits', offset, limit}   → Fase 3: visitas+conversión ML por lote (passthrough PG)
     POST /api/track {action:'meta', sku, patch}  → edita meta de un SKU
     POST /api/track {action:'import', rows}       → carga meta masiva (Excel)

   KV: track_products = {ts, items:[{id,sku,name,kit,avgWeekly,weeks:[{s,e,u,n}]}]}
       track_meta     = {sku:{firstSale,velMadura,velInicial}}
       track_metrics  = {ts, m:{sku:{firstSale, summary:{units,marginPct,tacos,ticket,velReal}, last:{...}, weeks:[{bucket,label,units,marginPct,ticket,tacos,stock}]}}}
                          (units = ventas TOTALES con kits = totalUnits de PG)
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
      const metrics = JSON.parse((await kv.get('track_metrics')) || 'null');
      return json({ products, meta, metrics });
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
          const r = await fetch(`${PG}/sales_speed/products?category=d&week_count=104&page=${page}&page_size=100`, { headers });
          if (!r.ok) { if (page === 1) return json({ error: `ProfitGuard ${r.status}` }, 502); break; }
          const j = await r.json();
          for (const it of (j.items || [])) {
            if (String(it.category || '').toLowerCase() !== 'd') continue;   // solo clase D (guard defensivo)
            if (it.kit) continue;                                            // excluir KITS (deben ser NO kit)
            items.push({
              id: it.id, sku: it.sku, name: (it.name || '').slice(0, 90), kit: !!it.kit, category: it.category || '',
              avgWeekly: it.averageWeeklySales != null ? it.averageWeeklySales : null,
              velApp: it.weeklySalesSpeed != null ? it.weeklySalesSpeed : null,   // "Vel. App" = velocidad que muestra PG
              stock: it.totalStock != null ? it.totalStock : null,               // stock total (todas las bodegas)

              weeks: (it.weeklySales || []).map(w => ({ s: w.startDate, e: w.endDate, u: w.units || 0, n: w.number }))
            });
          }
          const tp = (j.meta && j.meta.total_pages) || 1; if (page >= tp) break;
        }
        const out = { ts: Date.now(), items };
        await kv.put('track_products', JSON.stringify(out));
        return json({ ok: true, count: items.length, ts: out.ts });
      }

      if (action === 'refreshMetrics') {
        if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
        const prod = JSON.parse((await kv.get('track_products')) || 'null');
        const list = ((prod && prod.items) || []).filter(it => !it.kit && it.id);   // solo no-kit con id
        const offset = Math.max(parseInt(body.offset) || 0, 0);
        const limit = Math.min(Math.max(parseInt(body.limit) || 20, 1), 40);
        const slice = list.slice(offset, offset + limit);
        const store = JSON.parse((await kv.get('track_metrics')) || 'null') || { ts: Date.now(), m: {} };
        store.m = store.m || {};
        const FROM = '2024-06-01';   // los productos D se crearon ~2024-11; margen suficiente para captar la 1ª venta
        const today = new Date().toISOString().slice(0, 10);
        const todayMs = Date.parse(today + 'T00:00:00');
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        let first = true;
        for (const it of slice) {
          try {
            if (!first) await sleep(600);   // ~<120 req/min (límite PG)
            first = false;
            let r = await fetch(`${PG}/sales_speed/products/${it.id}?group_by=week&from=${FROM}&to=${today}`, { headers });
            if (r.status === 429) { await sleep(3000); r = await fetch(`${PG}/sales_speed/products/${it.id}?group_by=week&from=${FROM}&to=${today}`, { headers }); }   // reintento en rate limit
            if (!r.ok) { store.m[it.sku] = { error: `PG ${r.status}` }; continue; }
            const jr = await r.json();
            const j = jr.data || jr;   // el detalle REST envuelve en {data:{...}} (la lista no)
            const series = (j.chart && j.chart.series) || [];
            // OJO: en este endpoint el campo `cents` ya viene en PESOS (formattedValue "$15.955" = 15955), NO dividir por 100.
            const cents = o => (o && o.cents != null) ? o.cents : null;
            // "units" = ventas TOTALES (con kits) = totalUnits (no ownUnits, que es solo el listado propio).
            const weeks = series.map(w => ({
              bucket: w.bucket, label: w.label, units: w.totalUnits || 0,
              marginPct: w.marginPercentage != null ? w.marginPercentage : null,
              ticket: cents(w.averageTicket),
              tacos: w.adSpendPercentage != null ? w.adSpendPercentage : null,
              stock: w.stock != null ? w.stock : null
            }));
            const fi = weeks.findIndex(w => w.units > 0);
            const firstSale = fi >= 0 ? weeks[fi].bucket : null;
            const wkArr = fi >= 0 ? weeks.slice(fi) : [];
            // última semana CERRADA = último bucket cuyo fin (+6 días) es anterior a hoy
            let last = null;
            for (let i = weeks.length - 1; i >= 0; i--) {
              const end = Date.parse(weeks[i].bucket + 'T00:00:00') + 6 * 864e5;
              if (end < todayMs) { const w = weeks[i]; last = { units: w.units, marginPct: w.marginPct, tacos: w.tacos, ticket: w.ticket }; break; }
            }
            // velocidad real (con kits) = promedio de las últimas 8 semanas CERRADAS con actividad
            const closed = wkArr.filter(w => (Date.parse(w.bucket + 'T00:00:00') + 6 * 864e5) < todayMs);
            const recent = closed.slice(-8);
            const velReal = recent.length ? Math.round(recent.reduce((a, w) => a + (w.units || 0), 0) / recent.length * 10) / 10 : null;
            // summary desde 1ª venta = summary de PG (con kits; los ceros previos no alteran unidades ni margen/tacos ponderados)
            const summary = {
              units: j.totalUnits != null ? j.totalUnits : weeks.reduce((a, w) => a + (w.units || 0), 0),
              marginPct: j.marginPercentage != null ? j.marginPercentage : null,
              tacos: j.adSpendPercentage != null ? j.adSpendPercentage : null,
              ticket: cents(j.averageIncome),
              velReal
            };
            const prev = store.m[it.sku] || {};
            // Conserva visitas/conversión (Fase 3) y el caché de item ids, para no destruirlos al recomputar métricas.
            if (prev.summary) { summary.visits = prev.summary.visits; summary.conv = prev.summary.conv; }
            if (prev.last && last) { last.visits = prev.last.visits; last.conv = prev.last.conv; }
            if (prev.weeks && prev.weeks.length) {
              const pv = {}; for (const pw of prev.weeks) { if (pw.visits != null || pw.conv != null) pv[pw.bucket] = pw; }
              for (const w of wkArr) { const p = pv[w.bucket]; if (p) { if (p.visits != null) w.visits = p.visits; if (p.conv != null) w.conv = p.conv; } }
            }
            store.m[it.sku] = { firstSale, summary, last, weeks: wkArr, mlIds: prev.mlIds };
          } catch (e) { store.m[it.sku] = { error: String((e && e.message) || e) }; }
        }
        store.ts = Date.now();
        await kv.put('track_metrics', JSON.stringify(store));
        const next = (offset + limit < list.length) ? (offset + limit) : null;
        return json({ ok: true, processed: slice.length, offset, next, total: list.length, ts: store.ts });
      }

      if (action === 'refreshVisits') {   // Fase 3: visitas + conversión de Mercado Libre (passthrough PG)
        if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
        const SELLER = '613899966';   // ML User ID CL (ET Brands)
        const prod = JSON.parse((await kv.get('track_products')) || 'null');
        const list = ((prod && prod.items) || []).filter(it => !it.kit && it.sku);
        const offset = Math.max(parseInt(body.offset) || 0, 0);
        const limit = Math.min(Math.max(parseInt(body.limit) || 10, 1), 20);
        const slice = list.slice(offset, offset + limit);
        const store = JSON.parse((await kv.get('track_metrics')) || 'null') || { ts: Date.now(), m: {} };
        store.m = store.m || {};
        const today = new Date().toISOString().slice(0, 10);
        const todayMs = Date.parse(today + 'T00:00:00');
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        const round1 = v => Math.round(v * 10) / 10;
        const mondayOf = s => { const d = new Date(s.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
        // GET a ML por el passthrough de PG; null si falla o rate-limit (reintento simple).
        const mlGet = async (path, query) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetch(`${PG}/integrations/1/passthrough`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path, query: query || {} }) });
            const j = await r.json().catch(() => null);
            const b = j && (j.body != null ? j.body : null);
            const rl = b && (b.error === 'Rate limit exceeded' || (b.message && /rate limit/i.test(b.message)));
            if (rl && attempt === 0) { await sleep(4000); continue; }
            if (!r.ok || (j && j.status && j.status >= 400)) return null;
            return b;
          }
          return null;
        };
        let firstCall = true;
        for (const it of slice) {
          try {
            const m = store.m[it.sku] || { firstSale: null, summary: {}, last: null, weeks: [] };
            // 1) TODAS las publicaciones ML del SKU (tradicional + catálogo + variantes), paginando; cacheadas en m.mlIds
            let ids = m.mlIds;
            if (!Array.isArray(ids)) {
              ids = [];
              for (let pg = 0; pg < 6; pg++) {
                if (!firstCall) await sleep(500); firstCall = false;
                const s = await mlGet(`/users/${SELLER}/items/search`, { seller_sku: it.sku, limit: '50', offset: String(pg * 50) });
                const res = (s && Array.isArray(s.results)) ? s.results : [];
                ids.push(...res);
                const tot = (s && s.paging && s.paging.total != null) ? s.paging.total : res.length;
                if (!res.length || (pg + 1) * 50 >= tot) break;
              }
              m.mlIds = ids;
            }
            // 2) visitas SUMADAS de todas las publicaciones → agregado semanal (bucket = lunes ISO) + total
            const wk = {}; let total = 0;
            for (const id of ids.slice(0, 30)) {
              if (!firstCall) await sleep(500); firstCall = false;
              const v = await mlGet(`/items/${id}/visits/time_window`, { last: '150', unit: 'day' });
              if (!v) continue;
              total += v.total_visits || 0;
              for (const rr of (v.results || [])) { const wkb = mondayOf(rr.date); wk[wkb] = (wk[wkb] || 0) + (rr.total || 0); }
            }
            // 3) fusiona en las semanas de métricas: visitas + conversión (unidades/visitas)
            let sumU = 0, sumV = 0;
            (m.weeks || []).forEach(w => { const vv = wk[w.bucket]; if (vv != null) { w.visits = vv; w.conv = vv > 0 ? round1((w.units || 0) / vv * 100) : null; sumU += (w.units || 0); sumV += vv; } });
            m.summary = m.summary || {};
            m.summary.visits = total;
            m.summary.conv = sumV > 0 ? round1(sumU / sumV * 100) : null;
            // última semana cerrada: copia sus visitas/conv al bloque last
            if (m.last) { for (let i = (m.weeks || []).length - 1; i >= 0; i--) { const w = m.weeks[i]; if ((Date.parse(w.bucket + 'T00:00:00') + 6 * 864e5) < todayMs) { m.last.visits = w.visits != null ? w.visits : null; m.last.conv = w.conv != null ? w.conv : null; break; } } }
            store.m[it.sku] = m;
          } catch (e) { /* deja el producto sin visitas si falla */ }
        }
        store.ts = Date.now();
        await kv.put('track_metrics', JSON.stringify(store));
        const next = (offset + limit < list.length) ? (offset + limit) : null;
        return json({ ok: true, processed: slice.length, offset, next, total: list.length, ts: store.ts });
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
