/* ============================================================
   Cloudflare Pages Function — proxy de imágenes para embeber fotos
   en el Excel de cotizaciones (evita el bloqueo CORS al leer los bytes
   de las imágenes de Amazon / Mercado Libre desde el navegador).

   Ruta: GET /api/img?url=<url absoluta http(s) de una imagen>
   Devuelve la imagen tal cual (con CORS abierto y cache 1 día).
   Solo sirve imágenes (content-type image/*); nada más.
   ============================================================ */

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url') || '';
  let u;
  try { u = new URL(target); } catch (e) { return new Response('url inválida', { status: 400 }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return new Response('protocolo no permitido', { status: 400 });
  try {
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ETBrands-quote/1.0)', 'Accept': 'image/*' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!r.ok) return new Response('fetch ' + r.status, { status: 502 });
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return new Response('el recurso no es una imagen', { status: 415 });
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*'
      }
    });
  } catch (e) { return new Response(String((e && e.message) || e), { status: 500 }); }
}
