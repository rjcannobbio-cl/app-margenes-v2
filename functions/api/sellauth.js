/* ============================================================
   Cloudflare Pages Function — autorización de venta de productos cerrados.

   Solo el dueño (con el PIN) puede autorizar/desautorizar. Leer el estado es
   abierto (para pintar ✓/✗ en la tabla); escribir exige el PIN.

   Rutas:
     GET  /api/sellauth                         → { auth:{id:{ok,ts}}, configured }
     POST /api/sellauth { id, ok, pin }          → set/unset (valida PIN)

   PIN: secret `sell-auth-pin` (server-side; se configura en Cloudflare).
   KV: sell_auth = { <productId>: { ok:true, ts } }   (solo se guardan los autorizados)
   ============================================================ */

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const PIN = env['sell-auth-pin'] || env.sell_auth_pin || env.SELL_AUTH_PIN;

  try {
    if (request.method === 'GET') {
      const auth = JSON.parse((await kv.get('sell_auth')) || '{}');
      return json({ auth, configured: !!PIN });
    }
    if (request.method === 'POST') {
      if (!PIN) return json({ error: 'Falta configurar el secret sell-auth-pin en Cloudflare' }, 501);
      const b = await request.json().catch(() => ({}));
      const id = b && b.id != null ? String(b.id) : '';
      if (!id) return json({ error: 'falta id' }, 400);
      if (String(b.pin == null ? '' : b.pin) !== String(PIN)) return json({ error: 'PIN incorrecto' }, 403);
      const auth = JSON.parse((await kv.get('sell_auth')) || '{}');
      if (b.ok) auth[id] = { ok: true, ts: Date.now() };
      else delete auth[id];
      await kv.put('sell_auth', JSON.stringify(auth));
      return json({ ok: true, auth });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
