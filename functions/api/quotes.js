/* ============================================================
   Cloudflare Pages Function — cotizaciones (inquiries) COMPARTIDAS.
   Guarda en Cloudflare KV (binding MARGENES_KV) como un array JSON.
   Cada cotización = { id, name, qty, links, rows:[...], ts, ... }.

   Ruta: /api/quotes
     GET                 → array de cotizaciones
     POST  {cotiz}       → upsert por id (acepta 1 objeto o un array)
     DELETE ?id=<id>     → elimina esa cotización
     DELETE ?all=1       → vacía todo
   Clave por país: 'quotes' (CL) / 'quotes_co' (CO).
   ============================================================ */

function keyFor(url) {
  return url.searchParams.get('country') === 'co' ? 'quotes_co' : 'quotes';
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
      const body = await request.json();
      const items = Array.isArray(body) ? body : [body];
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      for (const item of items) {
        const i = item && item.id ? list.findIndex(x => x.id === item.id) : -1;
        if (i >= 0) list[i] = item; else list.push(item);
      }
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true, count: list.length, added: items.length });
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
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
