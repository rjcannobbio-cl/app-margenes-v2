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
const FIRST_NUM = 552;   // el primer inquiry nuevo es el N°552 (Rai); luego N+1.

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
      // Correlativo = max(num existentes) + 1, mínimo 552. Se deriva de la lista (self-healing, sin saltos por tests).
      let maxNum = FIRST_NUM - 1;
      for (const q of list) { if (q && typeof q.num === 'number' && q.num > maxNum) maxNum = q.num; }
      const saved = [];
      for (const item of items) {
        if (item.num == null || isNaN(item.num)) { maxNum++; item.num = maxNum; }   // asigna correlativo solo a los nuevos
        item.name = 'Inquiry N-' + item.num + (item.prodName ? ' - ' + item.prodName : '');
        const i = item && item.id ? list.findIndex(x => x.id === item.id) : -1;
        if (i >= 0) list[i] = item; else list.push(item);
        saved.push(item);
      }
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true, count: list.length, added: items.length, items: saved, item: saved[0] });
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
