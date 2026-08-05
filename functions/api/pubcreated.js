/* ============================================================
   Cloudflare Pages Function — "Publicaciones creadas" de productos cerrados.

   Solo el PM (con el PIN) puede marcar/desmarcar. Leer el estado es abierto
   (para pintar el checkbox en la tabla); escribir exige el PIN.

   Rutas:
     GET  /api/pubcreated                                  → { pub:{id:{channels,ts}}, configured }
     POST /api/pubcreated { id, channels:{ml,falabella,paris,ripley,walmart,shopify}, pin }  → set/unset (valida PIN)
     POST /api/pubcreated { id, ok, pin }                  → compat: marca todos los canales

   PIN fijo por código: "tendencias" (herramienta interna).
   KV: pub_created = { <productId>: { channels:{<canal>:true,...}, ts } }
   (formato antiguo { ok:true, ts } se interpreta como "todos los canales" al leer.)
   ============================================================ */

const PUB_CHANNELS = ['ml', 'falabella', 'paris', 'ripley', 'walmart', 'shopify'];

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const PIN = 'tendencias';   // clave del PM (herramienta interna)

  try {
    if (request.method === 'GET') {
      const pub = JSON.parse((await kv.get('pub_created')) || '{}');
      return json({ pub, configured: !!PIN });
    }
    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const id = b && b.id != null ? String(b.id) : '';
      if (!id) return json({ error: 'falta id' }, 400);
      if (String(b.pin == null ? '' : b.pin) !== String(PIN)) return json({ error: 'PIN incorrecto' }, 403);
      const pub = JSON.parse((await kv.get('pub_created')) || '{}');
      if (b.channels && typeof b.channels === 'object') {
        const channels = {}; let any = false;
        for (const k of PUB_CHANNELS) { if (b.channels[k]) { channels[k] = true; any = true; } }   // guarda solo los true (sparse)
        if (any) pub[id] = { channels, ts: Date.now() };
        else delete pub[id];                                                                        // sin canales → se quita
      } else if (b.ok) {   // compat: marca todos los canales
        const channels = {}; PUB_CHANNELS.forEach(k => channels[k] = true);
        pub[id] = { channels, ts: Date.now() };
      } else {
        delete pub[id];
      }
      await kv.put('pub_created', JSON.stringify(pub));
      return json({ ok: true, pub });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
