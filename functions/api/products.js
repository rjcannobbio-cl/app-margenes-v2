/* ============================================================
   Cloudflare Pages Function — historial COMPARTIDO de productos evaluados.
   Almacena en Cloudflare KV (binding MARGENES_KV) como un array JSON.
   Cada producto = un objeto (con todos sus campos, incluido SKU).

   Ruta: /api/products
     GET                 → array de productos
     POST  {producto}    → agrega un producto
     DELETE ?id=<id>     → elimina ese producto
     DELETE ?all=1       → vacía el historial

   Si el binding MARGENES_KV no está configurado, responde 501 y la app cae a
   la lista local del navegador (ver DEPLOY.md para crear el binding).
   ============================================================ */

// Clave por país: Chile usa 'list' (compatibilidad); Colombia 'list_co'.
function keyFor(url) {
  return url.searchParams.get('country') === 'co' ? 'list_co' : 'list';
}

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);

  const method = request.method;
  const url = new URL(request.url);
  const KEY = keyFor(url);
  try {
    if (method === 'GET') {
      const raw = await kv.get(KEY);
      return json(raw ? JSON.parse(raw) : []);
    }
    if (method === 'POST') {
      const item = await request.json();
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      const i = item && item.id ? list.findIndex(x => x.id === item.id) : -1;
      if (i >= 0) list[i] = item; else list.push(item);   // upsert por id
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true, count: list.length });
    }
    if (method === 'DELETE') {
      if (url.searchParams.get('all')) { await kv.put(KEY, '[]'); return json({ ok: true }); }
      const id = url.searchParams.get('id');
      const list = JSON.parse((await kv.get(KEY)) || '[]').filter(x => x.id !== id);
      await kv.put(KEY, JSON.stringify(list));
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
