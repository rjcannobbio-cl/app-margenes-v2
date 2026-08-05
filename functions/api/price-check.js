/* ============================================================
   Cloudflare Pages Function — chequeo de precios de Productos cerrados.

   Compara los precios Full/AON guardados en la app contra el precio REAL de venta
   en Mercado Libre (vía el passthrough de ProfitGuard). PG /products NO expone el
   precio de venta, así que se lee del ítem ML del SKU:
     - precio de LISTA (para comparar con "Full") = original_price (si hay promo) o base_price/price
     - precio VIGENTE (para comparar con "AON")    = price (lo que paga el comprador hoy, con promo activa)

   Rutas:
     GET  /api/price-check                               → { m:{ [productId]:{price,listPrice,itemId,permalink,matchedSku,notFound,ts} }, ts }
     POST /api/price-check { action:'refresh', items:[{id, skus:[...]}] }  → resuelve por lotes y cachea en KV

   KV: price_check = { ts, m:{...} }
   Usa el mismo secret de PG que el resto (solo Chile).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';
const SELLER = '613899966';   // ML User ID CL (ET Brands)

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;

  try {
    if (request.method === 'GET') {
      const pc = JSON.parse((await kv.get('price_check')) || 'null') || { m: {}, ts: 0 };
      return json(pc);
    }
    if (request.method === 'POST') {
      if (!token) return json({ error: 'Falta el secret de ProfitGuard' }, 501);
      const body = await request.json().catch(() => ({}));
      if (body.action !== 'refresh') return json({ error: 'acción no soportada' }, 400);
      const items = Array.isArray(body.items) ? body.items : [];
      const store = JSON.parse((await kv.get('price_check')) || 'null') || { m: {}, ts: 0 };
      store.m = store.m || {};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const mlGet = async (path, query) => {
        for (let a = 0; a < 2; a++) {
          const r = await fetch(`${PG}/integrations/1/passthrough`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path, query: query || {} }) });
          const j = await r.json().catch(() => null); const b = j && (j.body != null ? j.body : null);
          const rl = b && (b.error === 'Rate limit exceeded' || (b.message && /rate limit/i.test(b.message)));
          if (rl && a === 0) { await sleep(3500); continue; }
          if (!r.ok || (j && j.status && j.status >= 400)) return null;
          return b;
        }
        return null;
      };
      let first = true;
      for (const it of items) {
        const id = it && it.id != null ? String(it.id) : '';
        if (!id) continue;
        const skus = (Array.isArray(it.skus) ? it.skus : []).map(s => String(s || '').trim()).filter(Boolean);
        // dedup preservando orden (skuCierre > skuProveedor > sku)
        const seenSku = new Set(); const cand = skus.filter(s => (seenSku.has(s) ? false : (seenSku.add(s), true)));
        let found = null;
        try {
          for (const sku of cand) {
            if (!first) await sleep(350); first = false;
            const s = await mlGet(`/users/${SELLER}/items/search`, { seller_sku: sku, limit: '20' });
            const ids = (s && Array.isArray(s.results)) ? s.results : [];
            if (!ids.length) continue;
            let chosen = null;
            for (const iid of ids.slice(0, 10)) {
              await sleep(300);
              const item = await mlGet('/items/' + iid, { attributes: 'id,price,original_price,base_price,permalink,status' });
              if (!item) continue;
              if (!chosen) chosen = item;
              if (item.status === 'active') { chosen = item; break; }   // prioriza la publicación activa
            }
            if (chosen) { found = { sku, item: chosen }; break; }
          }
        } catch (e) { /* deja notFound si falla */ }
        if (found) {
          const item = found.item;
          const price = item.price != null ? item.price : null;                                   // vigente (con promo) → AON
          const listPrice = item.original_price != null ? item.original_price                     // lista tachada
            : (item.base_price != null ? item.base_price : price);                                // sin promo, lista = vigente → Full
          store.m[id] = { price, listPrice, itemId: item.id, permalink: item.permalink || null, status: item.status || null, matchedSku: found.sku, ts: Date.now() };
        } else {
          store.m[id] = { price: null, listPrice: null, itemId: null, notFound: true, ts: Date.now() };
        }
      }
      store.ts = Date.now();
      await kv.put('price_check', JSON.stringify(store));
      return json({ ok: true, processed: items.length, m: store.m });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
