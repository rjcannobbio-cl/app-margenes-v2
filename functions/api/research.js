/* ============================================================
   Cloudflare Pages Function — INVESTIGACIÓN de categorías (snapshot de Nubimetrics).
   Guarda en KV (clave 'research' / 'research_co') un array con las métricas por
   categoría hoja recolectadas desde Nubimetrics (visión global de ML).

   Nubimetrics NO tiene API key (auth por cookie de sesión), así que el servidor
   no puede consultarlo: los datos se recolectan desde el navegador del usuario
   (script recolector) y se importan aquí como snapshot.

   Ruta: /api/research
     GET            → array de categorías con métricas
     PUT  [items]   → reemplaza TODO (importar snapshot del recolector)
     POST {item}    → upsert de una categoría por id
     DELETE ?all=1  → vacía   |   DELETE ?id=<id> → elimina una
   ============================================================ */

function keyFor(url) {
  return url.searchParams.get('country') === 'co' ? 'research_co' : 'research';
}

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const url = new URL(request.url);
  const KEY = keyFor(url);
  try {
    if (request.method === 'GET') {
      const raw = await kv.get(KEY);
      return json(raw ? JSON.parse(raw) : []);
    }
    if (request.method === 'PUT') {
      const list = await request.json();
      const arr = Array.isArray(list) ? list : [];
      await kv.put(KEY, JSON.stringify(arr));
      return json({ ok: true, count: arr.length });
    }
    if (request.method === 'POST') {
      const item = await request.json();
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      const i = item && item.id ? list.findIndex(x => x.id === item.id) : -1;
      if (i >= 0) list[i] = item; else list.push(item);
      await kv.put(KEY, JSON.stringify(list));
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
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
