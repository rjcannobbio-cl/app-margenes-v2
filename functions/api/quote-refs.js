/* ============================================================
   Cloudflare Pages Function — resuelve LINKS DE REFERENCIA de producto
   a datos estructurados, para armar cotizaciones (inquiries) a fábricas.

   Ruta: POST /api/quote-refs   body { links:[...] }   (máx 20)
   Devuelve { ok, refs:[{ source, link, title, image, images[], bullets[],
                          specs[{name,value}], attributes[{name,value}], weight, price, error? }] }

   Fuentes:
     - Amazon  → ASIN de la URL → Rainforest API (type=product) → ficha real.
     - Mercado Libre → id de la URL → passthrough PG (público /items o /products).
     - Otros (Alibaba, etc.) → no resoluble automáticamente (se devuelve el link).

   Keys server-side (NUNCA al navegador): rainforest-api-key, app-margenes-pg-api-key.
   ============================================================ */

const RF = 'https://api.rainforestapi.com/request';
const PG = 'https://app.profitguard.cl/api/v1';
const ML_INTEGRATION_CL = 1;

export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'body inválido' }, 400); }
  const links = ((body && body.links) || []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
  if (!links.length) return json({ error: 'faltan links' }, 400);

  const rfKey = env['rainforest-api-key'] || env.rainforest_api_key || env.RAINFOREST_API_KEY;
  const pgKey = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;

  const refs = [];
  for (const link of links) {
    try { refs.push(await resolveOne(link, rfKey, pgKey)); }
    catch (e) { refs.push({ source: 'error', link, error: String((e && e.message) || e) }); }
  }
  return json({ ok: true, refs });
}

async function resolveOne(link, rfKey, pgKey) {
  const low = link.toLowerCase();
  if (/amazon\./.test(low)) return await resolveAmazon(link, rfKey);
  if (/mercadolibre\.|mercadolivre\.|\/p\/ml[a-z]|articulo\.|(^|\/)ml[a-z]-?\d{6,}/i.test(link)) return await resolveML(link, pgKey);
  return { source: 'otro', link, error: 'fuente no soportada automáticamente (pega Amazon o Mercado Libre, o llena la fila a mano)' };
}

/* ---------- Amazon (Rainforest) ---------- */
async function resolveAmazon(link, rfKey) {
  if (!rfKey) return { source: 'amazon', link, error: 'falta rainforest-api-key' };
  const m = link.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i) || link.match(/[/=]([A-Z0-9]{10})(?:[/?&]|$)/i);
  const asin = m && m[1].toUpperCase();
  if (!asin) return { source: 'amazon', link, error: 'no se pudo extraer el ASIN de la URL' };
  const r = await fetch(`${RF}?api_key=${encodeURIComponent(rfKey)}&type=product&amazon_domain=amazon.com&asin=${encodeURIComponent(asin)}`);
  const j = await r.json().catch(() => null);
  const p = j && j.product;
  if (!p) return { source: 'amazon', link, asin, error: 'Rainforest sin ficha (' + r.status + ')' };
  const images = (p.images || []).map(x => x.link).filter(Boolean);
  const mainImg = (p.main_image && p.main_image.link) || images[0] || '';
  return {
    source: 'amazon', link, asin,
    title: p.title || '',
    image: mainImg,
    images: (mainImg && !images.includes(mainImg) ? [mainImg] : []).concat(images).slice(0, 8),
    bullets: (p.feature_bullets || []).slice(0, 8),
    specs: (p.specifications || []).slice(0, 15).map(a => ({ name: a.name || '', value: a.value || '' })),
    attributes: [],
    weight: (p.weight || (p.dimensions && p.dimensions.weight) || '') + '',
    price: (p.buybox_winner && p.buybox_winner.price && p.buybox_winner.price.raw) || (p.price && p.price.raw) || ''
  };
}

/* ---------- Mercado Libre (passthrough público) ---------- */
async function resolveML(link, pgKey) {
  if (!pgKey) return { source: 'ml', link, error: 'falta la key de ProfitGuard' };
  const cat = link.match(/\/p\/(ML[A-Z]\d+)/i);
  const itm = link.match(/(ML[A-Z])-?(\d{6,})/i);
  let path, isCatalog = false, id;
  if (cat) { id = cat[1].toUpperCase(); path = `/products/${id}`; isCatalog = true; }
  else if (itm) { id = (itm[1] + itm[2]).toUpperCase(); path = `/items/${id}`; }
  else return { source: 'ml', link, error: 'no se pudo extraer el id de ML de la URL' };

  const query = isCatalog ? {} : { include_attributes: 'all' };
  const r = await fetch(`${PG}/integrations/${ML_INTEGRATION_CL}/passthrough`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path, query })
  });
  const jr = await r.json().catch(() => null);
  const b = jr && (jr.body != null ? jr.body : jr);
  if (!b || b.error) return { source: 'ml', link, id, error: 'passthrough: ' + ((b && b.error) || r.status) };

  const pics = (b.pictures || []).map(p => p.secure_url || p.url).filter(Boolean).slice(0, 8);
  const attrs = (b.attributes || []).map(a => ({
    name: a.name || '',
    value: a.value_name || (a.values && a.values[0] && a.values[0].name) || (a.value_struct && (a.value_struct.number + ' ' + (a.value_struct.unit || ''))) || ''
  })).filter(a => a.value);
  return {
    source: 'ml', link, id,
    title: b.title || b.name || '',
    image: pics[0] || '',
    images: pics,
    bullets: (b.main_features || []).map(f => f.text || '').filter(Boolean).slice(0, 8),
    specs: [],
    attributes: attrs.slice(0, 25),
    weight: '',
    price: b.price || (b.buy_box_winner && b.buy_box_winner.price) || ''
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
