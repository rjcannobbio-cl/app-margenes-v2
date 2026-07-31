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

/* ---------- Mercado Libre ----------
   ML bloquea con nuestro token el acceso por API a items ajenos (/items → 403) y a la
   búsqueda pública. Solo el catálogo /products/{id} sobrevive. Estrategia:
     1) si el link es de catálogo (/p/MLCxxxx) → /products/ por passthrough (rico: fotos + atributos).
     2) si no (o si falla) → leer la PÁGINA pública de ML (og: + JSON-LD). Sirve para /up/MLCU y artículos. */
async function resolveML(link, pgKey) {
  const cat = link.match(/\/p\/(ML[A-Z]\d+)/i);
  if (cat && pgKey) {
    const b = await mlPassthrough(`/products/${cat[1].toUpperCase()}`, {}, pgKey);
    if (b && !b.error) {
      const pics = (b.pictures || []).map(p => p.secure_url || p.url).filter(Boolean).slice(0, 8);
      const attrs = (b.attributes || []).map(a => ({ name: a.name || '', value: a.value_name || (a.values && a.values[0] && a.values[0].name) || '' })).filter(a => a.value);
      return {
        source: 'ml', link, id: cat[1].toUpperCase(),
        title: b.name || b.title || '', image: pics[0] || '', images: pics,
        bullets: (b.main_features || []).map(f => (typeof f === 'string' ? f : (f.text || ''))).filter(Boolean).slice(0, 8),
        specs: [], attributes: attrs.slice(0, 25), weight: '', price: ''
      };
    }
  }
  const page = await resolveMLPage(link);
  if (page && page.title) return page;
  return { source: 'ml', link, error: 'ML no permite leer esta publicación por API (items de terceros dan 403). Prueba con el link de catálogo (/p/MLC…) o llena la fila a mano.', _dbg: (page && page._dbg) || 'null' };
}

// Passthrough GET a ML; devuelve el body o { error }.
async function mlPassthrough(path, query, pgKey) {
  try {
    const r = await fetch(`${PG}/integrations/${ML_INTEGRATION_CL}/passthrough`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + pgKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path, query: query || {} })
    });
    const jr = await r.json().catch(() => null);
    const b = jr && (jr.body != null ? jr.body : jr);
    if (!r.ok || !b || b.error) return { error: (b && b.error) || ('passthrough ' + r.status) };
    return b;
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

// Lee la página pública de ML y extrae título/imágenes/descripción (og: + JSON-LD Product).
async function resolveMLPage(link) {
  try {
    const r = await fetch(link.split('#')[0], {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'es-CL,es;q=0.9'
      }
    });
    const html = r.ok ? await r.text() : '';
    if (!r.ok) return { _dbg: { status: r.status, len: 0 } };
    const og = prop => {
      const m = html.match(new RegExp('<meta[^>]+property=["\\\']og:' + prop + '["\\\'][^>]*content=["\\\']([^"\\\']+)["\\\']', 'i'))
        || html.match(new RegExp('<meta[^>]+content=["\\\']([^"\\\']+)["\\\'][^>]*property=["\\\']og:' + prop + '["\\\']', 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    const title = og('title');
    const images = [];
    const mainImg = og('image'); if (mainImg) images.push(mainImg);
    let desc = '';
    const lds = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of lds) {
      const txt = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      try {
        const o = JSON.parse(txt);
        const arr = Array.isArray(o) ? o : (o['@graph'] && Array.isArray(o['@graph']) ? o['@graph'] : [o]);
        const prod = arr.find(x => x && (x['@type'] === 'Product' || x.name));
        if (prod) {
          if (prod.description) desc = String(prod.description);
          if (prod.image) (Array.isArray(prod.image) ? prod.image : [prod.image]).forEach(u => { if (u && !images.includes(u)) images.push(u); });
          break;
        }
      } catch (e) {}
    }
    if (!title && !images.length) return { _dbg: { status: r.status, len: html.length, hasOg: /og:title/i.test(html), snippet: html.slice(0, 200) } };
    return {
      source: 'ml', link, id: (link.match(/(ML[A-Z]U?\d+)/i) || [])[1] || '',
      title, image: images[0] || '', images: images.slice(0, 8),
      bullets: desc ? [desc.replace(/\s+/g, ' ').trim().slice(0, 700)] : [],
      specs: [], attributes: [], weight: '', price: '', viaPage: true
    };
  } catch (e) { return { _dbg: { err: String((e && e.message) || e) } }; }
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/gi, '/');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
