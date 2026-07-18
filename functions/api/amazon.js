/* ============================================================
   Cloudflare Pages Function — referencias de producto en Amazon vía Rainforest API.

   Para el P2: dado un término de búsqueda de una sugerencia de la IA, busca en
   Amazon.com y entra a la ficha de cada candidato para traer sus specs reales
   (para que la IA verifique que efectivamente corresponde a lo sugerido).

   Ruta: POST /api/amazon   body { q, num }
     q   = términos de búsqueda (keywords)
     num = cuántos candidatos con detalle traer (1-4, default 3)
   Devuelve { ok, q, candidates:[{asin,title,link,image,price,rating,reviews,specs}], cached }

   Key: secret `rainforest-api-key` (server-side, NUNCA al navegador).
   Cache en KV (clave amz:<q>) por 30 días para no gastar requests de más.
   ============================================================ */

const RF = 'https://api.rainforestapi.com/request';
const DOMAIN = 'amazon.com';
const TTL = 30 * 24 * 3600 * 1000;

export async function onRequestPost({ request, env }) {
  const key = env['rainforest-api-key'] || env.rainforest_api_key || env.RAINFOREST_API_KEY;
  if (!key) return json({ error: 'Falta el secret rainforest-api-key' }, 501);
  const kv = env.MARGENES_KV;

  let body; try { body = await request.json(); } catch (e) { return json({ error: 'body inválido' }, 400); }
  const q = (body && body.q || '').toString().trim();
  if (!q) return json({ error: 'falta q' }, 400);
  const num = Math.min(Math.max(parseInt(body && body.num) || 3, 1), 4);
  const minReviews = Math.max(parseInt(body && body.minReviews) || 0, 0);   // prueba de venta
  const minUsd = (body && body.minUsd != null) ? +body.minUsd : null;        // rango de precio (USD)
  const maxUsd = (body && body.maxUsd != null) ? +body.maxUsd : null;
  const ck = 'amz:' + [q, minReviews, minUsd, maxUsd].join('_').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);

  // Cache (evita gastar requests del trial en la misma búsqueda).
  if (kv) { try { const c = JSON.parse((await kv.get(ck)) || 'null'); if (c && c.ts && (Date.now() - c.ts < TTL)) return json({ ok: true, q, cached: true, candidates: c.candidates }); } catch (e) {} }

  try {
    // 1) Búsqueda (traemos muchos y filtramos ANTES de gastar requests en las fichas).
    const sr = await fetch(`${RF}?api_key=${encodeURIComponent(key)}&type=search&amazon_domain=${DOMAIN}&search_term=${encodeURIComponent(q)}`);
    const sj = await sr.json().catch(() => null);
    if (!sr.ok) return json({ error: 'Rainforest search ' + sr.status, detail: sj && (sj.request_info || sj) }, 502);
    const priceVal = r => (r.price && typeof r.price.value === 'number') ? r.price.value : null;
    const results = ((sj && sj.search_results) || []).filter(r => {
      if (!r || !r.asin || !r.title || r.sponsored) return false;
      if ((r.ratings_total || 0) < minReviews) return false;                 // reseñas mínimas
      const pv = priceVal(r);
      if (minUsd != null || maxUsd != null) { if (pv == null) return false; if (minUsd != null && pv < minUsd) return false; if (maxUsd != null && pv > maxUsd) return false; }
      return true;
    }).slice(0, num);

    // 2) Detalle (ficha) de cada candidato → specs reales para verificar.
    const candidates = [];
    for (const r of results) {
      let specs = '';
      try {
        const pr = await fetch(`${RF}?api_key=${encodeURIComponent(key)}&type=product&amazon_domain=${DOMAIN}&asin=${encodeURIComponent(r.asin)}`);
        const pj = await pr.json().catch(() => null);
        const p = pj && pj.product;
        if (p) {
          const bullets = (p.feature_bullets || []).slice(0, 6).join(' · ');
          const attrs = (p.specifications || []).slice(0, 10).map(a => (a.name || '') + ': ' + (a.value || '')).join(' · ');
          specs = (bullets + (attrs ? ' | ' + attrs : '')).replace(/\s+/g, ' ').trim().slice(0, 700);
        }
      } catch (e) {}
      candidates.push({
        asin: r.asin,
        title: (r.title || '').slice(0, 160),
        link: r.link || ('https://www.amazon.com/dp/' + r.asin),
        image: r.image || null,
        price: r.price ? (r.price.raw || (r.price.value != null ? '$' + r.price.value : null)) : null,
        rating: r.rating != null ? r.rating : null,
        reviews: r.ratings_total != null ? r.ratings_total : null,
        specs
      });
    }
    if (kv) { try { await kv.put(ck, JSON.stringify({ ts: Date.now(), candidates })); } catch (e) {} }
    return json({ ok: true, q, candidates, requests: 1 + results.length });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
