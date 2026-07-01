/* ============================================================
   Cloudflare Pages Function — parámetros COMPARTIDOS del equipo.
   Guarda en Cloudflare KV (binding MARGENES_KV, clave 'settings') los valores
   que deben ser iguales para todos: factor CBM, dólar, IVA, reputación Falabella.
   (La API key NO va aquí: es personal de cada navegador.)

   Ruta: /api/settings
     GET            → objeto con los parámetros compartidos
     PUT  {params}  → guarda los parámetros compartidos

   Si MARGENES_KV no está configurado, responde 501 y la app usa los valores
   locales de cada navegador.
   ============================================================ */

// Clave por país: Chile usa 'settings' (compatibilidad); Colombia 'settings_co'.
function keyFor(request) {
  const c = new URL(request.url).searchParams.get('country');
  return c === 'co' ? 'settings_co' : 'settings';
}

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const KEY = keyFor(request);
  try {
    if (request.method === 'GET') {
      const raw = await kv.get(KEY);
      return json(raw ? JSON.parse(raw) : {});
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.json();
      await kv.put(KEY, JSON.stringify(body));
      return json({ ok: true });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
