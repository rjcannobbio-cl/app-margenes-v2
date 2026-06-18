/* ============================================================
   Cloudflare Pages Function — lista COMPARTIDA de productos evaluados.
   Ruta: /api/products
     GET                 → devuelve el array de productos (JSON)
     POST  {producto}    → agrega un producto
     DELETE ?id=<id>     → elimina un producto
     DELETE ?all=1       → vacía la lista
   Almacena en Cloudflare KV (binding MARGENES_KV). Si el binding no está
   configurado, responde 501 y la app cae a la lista local del navegador.
   ============================================================ */

const KEY = 'list';

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);

  const method = request.method;
  const url = new URL(request.url);

  try {
    if (method === 'GET') {
      const raw = await kv.get(KEY);
      return json(raw ? JSON.parse(raw) : []);
    }
    if (method === 'POST') {
      const item = await request.json();
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      list.push(item);
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true, count: list.length });
    }
    if (method === 'DELETE') {
      if (url.searchParams.get('all')) { await kv.put(KEY, '[]'); return json({ ok: true }); }
      const id = url.searchParams.get('id');
      const list = JSON.parse((await kv.get(KEY)) || '[]').filter(x => x.id !== id);
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true, count: list.length });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
