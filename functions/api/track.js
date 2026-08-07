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
      const actions = JSON.parse((await kv.get('track_actions')) || '{}');
      const review = JSON.parse((await kv.get('track_review')) || '{}');
      return json({ products, meta, metrics, actions, review });
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
            // Conserva visitas/conversión (Fase 3) + stock full/campaña (refreshFullAds) y el caché de item ids, para no destruirlos al recomputar métricas.
            if (prev.summary) { summary.visits = prev.summary.visits; summary.conv = prev.summary.conv; summary.fullStock = prev.summary.fullStock; summary.inboundStock = prev.summary.inboundStock; summary.adCampaign = prev.summary.adCampaign; }
            if (prev.last && last) { last.visits = prev.last.visits; last.conv = prev.last.conv; }
            if (prev.weeks && prev.weeks.length) {
              const pv = {}; for (const pw of prev.weeks) { if (pw.visits != null || pw.conv != null) pv[pw.bucket] = pw; }
              for (const w of wkArr) { const p = pv[w.bucket]; if (p) { if (p.visits != null) w.visits = p.visits; if (p.conv != null) w.conv = p.conv; } }
            }
            // Día EXACTO de la 1ª venta (el bucket semanal es el lunes → los días salían en múltiplos de 7). Cacheado.
            let firstSaleDay = firstSale;
            if (fi >= 0) {
              if (prev.firstSaleDay) firstSaleDay = String(prev.firstSaleDay).slice(0, 10);
              else {
                const wkStart = weeks[fi].bucket;
                const wkEnd = new Date(Date.parse(wkStart + 'T00:00:00') + 6 * 864e5).toISOString().slice(0, 10);
                try {
                  await sleep(600);
                  const rd = await fetch(`${PG}/sales_speed/products/${it.id}?group_by=day&from=${wkStart}&to=${wkEnd}`, { headers });
                  if (rd.ok) { const dd = (await rd.json()); const dj = dd.data || dd; const dser = (dj.chart && dj.chart.series) || []; const fday = dser.find(x => (x.totalUnits || 0) > 0); if (fday && fday.bucket) firstSaleDay = String(fday.bucket).slice(0, 10); }
                } catch (e) {}
              }
            }
            store.m[it.sku] = { firstSale, firstSaleDay, summary, last, weeks: wkArr, mlIds: prev.mlIds };
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
        // Modo dirigido: si viene body.skus (lista), procesa SOLO esos (para la 2ª pasada de pendientes). Si no, por lotes offset/limit.
        const targeted = Array.isArray(body.skus) && body.skus.length;
        const offset = Math.max(parseInt(body.offset) || 0, 0);
        const limit = Math.min(Math.max(parseInt(body.limit) || 10, 1), 20);
        const slice = targeted ? (() => { const set = new Set(body.skus); return list.filter(it => set.has(it.sku)); })() : list.slice(offset, offset + limit);
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
            // 1) TODAS las publicaciones ML del SKU (tradicional + catálogo + variantes), paginando; cacheadas en m.mlIds.
            // Re-buscar si NO hay cache O si quedó VACÍO (una falla transitoria/rate-limit no debe quedar cacheada como "sin publicaciones").
            let ids = m.mlIds;
            if (!Array.isArray(ids) || !ids.length) {
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
        const next = targeted ? null : ((offset + limit < list.length) ? (offset + limit) : null);
        return json({ ok: true, processed: slice.length, offset, next, total: list.length, ts: store.ts });
      }

      if (action === 'refreshFullAds') {   // Stock en Full + en camino + campaña de Product Ads (ML), sumando todas las publicaciones del SKU
        if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
        const SELLER = '613899966', SITE = 'MLC', ADVERTISER = '78477';
        const prod = JSON.parse((await kv.get('track_products')) || 'null');
        const listAll = ((prod && prod.items) || []).filter(it => !it.kit && it.sku);
        const offset = Math.max(parseInt(body.offset) || 0, 0);
        const limit = Math.min(Math.max(parseInt(body.limit) || 6, 1), 15);
        // Modo dirigido: body.skus (lista) procesa SOLO esos (para 2ª pasada / diagnóstico). body.force re-busca publicaciones ignorando caché.
        const targeted = Array.isArray(body.skus) && body.skus.length;
        const slice = targeted ? (() => { const set = new Set(body.skus); return listAll.filter(it => set.has(it.sku)); })() : listAll.slice(offset, offset + limit);
        const store = JSON.parse((await kv.get('track_metrics')) || 'null') || { ts: Date.now(), m: {} };
        store.m = store.m || {};
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        // Passthrough GET con headers opcionales (advertising exige api-version).
        const mlGet = async (path, query, hdrs) => {
          for (let a = 0; a < 2; a++) {
            const pb = { method: 'GET', path, query: query || {} };
            if (hdrs) pb.headers = hdrs;
            const r = await fetch(`${PG}/integrations/1/passthrough`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(pb) });
            const j = await r.json().catch(() => null); const b = j && (j.body != null ? j.body : null);
            const rl = b && (b.error === 'Rate limit exceeded' || (b.message && /rate limit/i.test(b.message)));
            if (rl && a === 0) { await sleep(3000); continue; }
            if (!r.ok || (j && j.status && j.status >= 400)) return null;
            return b;
          }
          return null;
        };
        // Mapa campaign_id → nombre (una sola vez por lote).
        const campMap = {};
        const campRaw = await mlGet(`/advertising/${SITE}/advertisers/${ADVERTISER}/product_ads/campaigns/search`, { limit: '200' }, { 'api-version': '2' });
        for (const cc of ((campRaw && campRaw.results) || [])) campMap[cc.id] = cc.name;
        let first = true; const dbg = body.debug ? { campaignsFound: Object.keys(campMap).length, skus: [] } : null;
        for (const it of slice) {
          const dbgSku = dbg ? { sku: it.sku, items: [] } : null;
          try {
            const m = store.m[it.sku] || {}; m.summary = m.summary || {};
            let ids = m.mlIds;
            if (body.force || !Array.isArray(ids) || !ids.length) {
              ids = [];
              for (let pg = 0; pg < 6; pg++) { if (!first) await sleep(400); first = false; const s = await mlGet(`/users/${SELLER}/items/search`, { seller_sku: it.sku, limit: '50', offset: String(pg * 50) }); const res = (s && Array.isArray(s.results)) ? s.results : []; ids.push(...res); const tot = (s && s.paging && s.paging.total != null) ? s.paging.total : res.length; if (!res.length || (pg + 1) * 50 >= tot) break; }
              m.mlIds = ids;
            }
            if (dbgSku) dbgSku.idsCount = ids.length;
            // 1) Lee las publicaciones; junta los inventory_id ÚNICOS (varias publicaciones comparten el mismo → no duplicar).
            //    Campaña: junta TODAS las campañas distintas de los ads del SKU (un SKU puede tener varias publicaciones en distintas
            //    campañas; elegir una sola engañaba). Se muestran con la ACTIVA primero.
            let okItems = 0, adAnyOk = false;
            const invSet = new Set();
            const camps = new Map();   // nombre campaña -> ¿algún ad activo?
            for (const id of ids.slice(0, 20)) {
              if (!first) await sleep(300); first = false;
              const item = await mlGet('/items/' + id, { attributes: 'id,inventory_id,shipping,variations,status' });
              const itemStatus = (item && item.status) || null;
              if (item) {
                okItems++;
                const isFull = item.shipping && item.shipping.logistic_type === 'fulfillment';
                if (isFull) { if (item.inventory_id) invSet.add(item.inventory_id); for (const v of (item.variations || [])) if (v.inventory_id) invSet.add(v.inventory_id); }
              }
              let cid = null, adStatus = null;
              const ad = await mlGet(`/advertising/${SITE}/product_ads/ads/${id}`, {}, { 'api-version': '2' });
              if (ad) {
                adAnyOk = true; cid = ad.campaign_id; adStatus = ad.status || null;
                if (cid) { const name = campMap[cid] || ('#' + cid); const active = adStatus === 'active' || (adStatus == null && itemStatus === 'active'); camps.set(name, (camps.get(name) || false) || active); }
              }
              if (dbgSku) dbgSku.items.push({ id, logistic: (item && item.shipping && item.shipping.logistic_type) || null, itemStatus, itemOk: !!item, adCid: cid, adStatus, adCamp: cid ? (campMap[cid] || ('#' + cid)) : null });
            }
            // Campañas distintas, activa(s) primero.
            const campaign = camps.size ? [...camps.keys()].sort((a, b) => (camps.get(b) ? 1 : 0) - (camps.get(a) ? 1 : 0)).join(' · ') : '';
            // 2) Stock full = suma de available_quantity de cada inventario ÚNICO (una sola vez).
            let full = 0, inbound = 0, invOk = false;
            for (const inv of invSet) {
              if (!first) await sleep(300); first = false;
              const st = await mlGet(`/inventories/${inv}/stock/fulfillment`);
              if (st && st.available_quantity != null) { invOk = true; full += (st.available_quantity || 0); for (const d of (st.not_available_detail || [])) if (/transfer|internal_process/i.test(d.status || '')) inbound += (d.quantity || 0); }
            }
            // 3) Escribe SOLO si logramos leer publicaciones (evita que un rate-limit borre datos buenos).
            if (okItems > 0) {
              if (invSet.size === 0) { m.summary.fullStock = 0; m.summary.inboundStock = 0; }   // leímos y no está en full → 0
              else if (invOk) { m.summary.fullStock = full; m.summary.inboundStock = inbound; }   // inventarios leídos OK
              // (si invSet>0 pero invOk=false → todos los inventarios fallaron: preserva el valor previo)
              if (campaign) m.summary.adCampaign = campaign;
              else if (adAnyOk) m.summary.adCampaign = null;   // consultamos ads y no hay campaña
              // (si !adAnyOk → todas las consultas de ads fallaron: preserva la campaña previa)
            }
            store.m[it.sku] = m;
            if (dbgSku) { dbgSku.invUnique = [...invSet]; dbgSku.okItems = okItems; dbgSku.invOk = invOk; dbgSku.fullStock = m.summary.fullStock; dbgSku.adCampaign = m.summary.adCampaign; }
          } catch (e) { if (dbgSku) dbgSku.err = String(e && e.message || e); }
          if (dbg) dbg.skus.push(dbgSku);
        }
        store.ts = Date.now();
        await kv.put('track_metrics', JSON.stringify(store));
        const next = targeted ? null : ((offset + limit < listAll.length) ? (offset + limit) : null);
        return json({ ok: true, processed: slice.length, offset, next, total: listAll.length, dbg });
      }

      if (action === 'links') {   // publicaciones del producto + sus packs, por canal, con link directo a cada marketplace
        if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
        const pid = parseInt(body.id) || 0;
        if (!pid) return json({ error: 'falta id' }, 400);
        const SELLER = '613899966';
        const mlGet = async (path, query) => {
          const r = await fetch(`${PG}/integrations/1/passthrough`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path, query: query || {} }) });
          const j = await r.json().catch(() => null); const b = j && (j.body != null ? j.body : null);
          if (!r.ok || (j && j.status && j.status >= 400)) return null; return b;
        };
        const shopifyHandle = async vid => {
          try {
            const r = await fetch(`${PG}/integrations/15/graphql_passthrough`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `{ productVariant(id: "${vid}") { product { handle } } }` }) });
            const j = await r.json().catch(() => null); const b = j && (j.body != null ? j.body : j);
            const h = b && b.data && b.data.productVariant && b.data.productVariant.product && b.data.productVariant.product.handle;
            return h || null;
          } catch (e) { return null; }
        };
        // Publicaciones (por canal) de un producto PG dado.
        const pubsFor = async (prodId, sku) => {
          let pd = null;
          try { const r = await fetch(`${PG}/products/${prodId}`, { headers }); if (r.ok) { const p = await r.json(); pd = p.data || p; } } catch (e) {}
          const eps = (pd && pd.externalProducts) || [];
          const out = [];
          for (const e of eps) {
            const type = ((e.integration || {}).type) || '', canal = ((e.integration || {}).name) || type, ext = e.externalId || '';
            let url = null;
            if (type === 'falabella/integration') { const n = parseInt(ext, 10); url = isNaN(n) ? null : ('https://www.falabella.com/falabella-cl/product/' + (n - 1) + '/x/' + n); }   // PG guarda el variantId; el productId de la URL = variantId-1
            else if (type === 'cencosud/integration') url = 'https://www.paris.cl/' + ext.replace(/-\d+$/, '') + '.html';
            else if (type === 'ripley/integration') url = 'https://simple.ripley.cl/' + ext.replace(/-\d+$/, '').toLowerCase();
            else if (type === 'shopify/integration') { const h = await shopifyHandle(ext); if (h) url = 'https://etbrands.cl/products/' + h; }
            else if (type === 'mercado_libre/integration' || type === 'multivende/integration' || type === 'walmart/integration') continue;   // ML se resuelve por permalink; multivende/walmart sin link directo confiable
            out.push({ canal, externalId: ext, url, active: !!e.active });
          }
          // Mercado Libre: permalink real (por SKU → items → permalink)
          if (sku) {
            try {
              const s = await mlGet(`/users/${SELLER}/items/search`, { seller_sku: sku });
              const ids = (s && Array.isArray(s.results)) ? s.results : [];
              for (const id of ids.slice(0, 5)) {
                const it = await mlGet(`/items/${id}`, { attributes: 'permalink,status' });
                if (it && it.permalink) out.push({ canal: 'Mercado Libre', externalId: id, url: it.permalink, active: it.status === 'active' });
              }
            } catch (e) {}
          }
          const seen = new Set(), dedup = [];   // evita duplicados (ej. Paris con variante -1 → misma URL)
          for (const o of out) { const k = o.url || (o.canal + '|' + o.externalId); if (seen.has(k)) continue; seen.add(k); dedup.push(o); }
          return dedup;
        };
        const productPubs = await pubsFor(pid, body.sku || '');
        // Packs que contienen el producto (kits desde sales_speed) + sus publicaciones.
        const packs = [];
        try {
          const sr = await fetch(`${PG}/sales_speed/products/${pid}?group_by=week`, { headers });
          if (sr.ok) { const sj = await sr.json(); const sd = sj.data || sj; const kits = (sd.kits) || [];
            for (const k of kits) { const kp = await pubsFor(k.id, k.sku); packs.push({ id: k.id, sku: k.sku, name: k.name, qty: k.quantity, pubs: kp }); }
          }
        } catch (e) {}
        return json({ ok: true, product: { id: pid, sku: body.sku || '', pubs: productPubs }, packs });
      }

      // ---- Accionables (sugerencias/seguimiento de acciones para madurez/margen) ----
      if (action === 'actionAdd') {
        if (!body.sku || !body.type) return json({ error: 'falta sku/type' }, 400);
        const store = JSON.parse((await kv.get('track_actions')) || '{}');
        const list = store[body.sku] || [];
        const item = {
          id: 'a' + Date.now() + Math.floor(Math.random() * 1000),
          type: String(body.type).slice(0, 60),
          desc: String(body.desc || '').slice(0, 3000),
          responsable: String(body.responsable || '').slice(0, 60),
          created: Date.now(), status: 'pending', doneDate: null
        };
        list.push(item); store[body.sku] = list;
        await kv.put('track_actions', JSON.stringify(store));
        return json({ ok: true, list });
      }
      if (action === 'actionEdit') {   // editar SOLO la descripción de un accionable
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_actions')) || '{}');
        const list = store[body.sku] || [];
        const it = list.find(x => x.id === body.id);
        if (it) it.desc = String(body.desc || '').slice(0, 3000);
        store[body.sku] = list;
        await kv.put('track_actions', JSON.stringify(store));
        return json({ ok: true, list });
      }
      if (action === 'actionDone') {
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_actions')) || '{}');
        const list = store[body.sku] || [];
        const it = list.find(x => x.id === body.id);
        if (it) { it.status = 'done'; it.doneDate = Date.now(); }
        store[body.sku] = list;
        await kv.put('track_actions', JSON.stringify(store));
        return json({ ok: true, list });
      }
      if (action === 'actionDelete') {
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_actions')) || '{}');
        store[body.sku] = (store[body.sku] || []).filter(x => x.id !== body.id);
        await kv.put('track_actions', JSON.stringify(store));
        return json({ ok: true, list: store[body.sku] });
      }

      // ---- Revisión física (productos nuevos que llegan a bodega) ----
      // track_review = { [sku]: { initiated, approved, reviewedAt, actions:[{id,type,desc,responsable,created,status,doneDate}] } }
      // Estado (derivado en el front): sin registro=NO · approved sin acciones o todas hechas=SÍ · con acciones pendientes=EN PROCESO.
      const newRevAct = (a, i) => ({
        id: 'r' + Date.now() + '-' + (i || 0) + '-' + Math.floor(Math.random() * 100000),
        type: String((a && a.type) || '').slice(0, 60),
        desc: String((a && a.desc) || '').slice(0, 3000),
        responsable: String((a && a.responsable) || '').slice(0, 60),
        created: Date.now(), status: 'pending', doneDate: null
      });
      if (action === 'reviewInit') {   // da el visto bueno (approved) o crea el listado inicial de accionables
        if (!body.sku) return json({ error: 'falta sku' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        const approved = !!body.approved;
        const acts = Array.isArray(body.actions) ? body.actions : [];
        store[body.sku] = { initiated: true, approved, reviewedAt: Date.now(), actions: approved ? [] : acts.map(newRevAct) };
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec: store[body.sku] });
      }
      if (action === 'reviewActionAdd') {   // agrega un accionable de revisión (pasa a EN PROCESO)
        if (!body.sku || !body.type) return json({ error: 'falta sku/type' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        const rec = store[body.sku] || { initiated: true, approved: false, reviewedAt: Date.now(), actions: [] };
        rec.initiated = true; rec.approved = false; rec.actions = rec.actions || [];
        rec.actions.push(newRevAct(body, rec.actions.length));
        store[body.sku] = rec;
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec });
      }
      if (action === 'reviewActionDone') {
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        const rec = store[body.sku]; if (rec && rec.actions) { const it = rec.actions.find(x => x.id === body.id); if (it) { it.status = 'done'; it.doneDate = Date.now(); } }
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec: store[body.sku] || null });
      }
      if (action === 'reviewActionEdit') {
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        const rec = store[body.sku]; if (rec && rec.actions) { const it = rec.actions.find(x => x.id === body.id); if (it) it.desc = String(body.desc || '').slice(0, 3000); }
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec: store[body.sku] || null });
      }
      if (action === 'reviewActionDelete') {
        if (!body.sku || !body.id) return json({ error: 'falta sku/id' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        const rec = store[body.sku]; if (rec && rec.actions) rec.actions = rec.actions.filter(x => x.id !== body.id);
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec: store[body.sku] || null });
      }
      if (action === 'reviewReset') {   // vuelve a NO (borra la revisión del SKU)
        if (!body.sku) return json({ error: 'falta sku' }, 400);
        const store = JSON.parse((await kv.get('track_review')) || '{}');
        delete store[body.sku];
        await kv.put('track_review', JSON.stringify(store));
        return json({ ok: true, rec: null });
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
