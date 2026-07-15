/* ============================================================
   Cloudflare Pages Function — cache de análisis P2 por categoría (KV).

   El análisis P2 (estacionalidad, clusters de productos, reseñas, diferenciación)
   se arma en el navegador combinando datos ya guardados + ML (via /api/ml) + IA.
   Es caro de recomputar, así que se cachea aquí por id de categoría hoja.

   Ruta: /api/p2
     GET  ?id=<catId>       → { report, ts } | null
     PUT  { id, report }    → guarda (upsert)
     DELETE ?id=<catId>     → borra   |  DELETE ?all=1 → vacía
   Clave KV: 'p2cache' (CL) / 'p2cache_co' (CO) = { [catId]: { ts, report } }
   ============================================================ */

function keyFor(url) {
  return url.searchParams.get('country') === 'co' ? 'p2cache_co' : 'p2cache';
}

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const url = new URL(request.url);
  const KEY = keyFor(url);
  try {
    const all = JSON.parse((await kv.get(KEY)) || '{}');
    if (request.method === 'GET') {
      const id = url.searchParams.get('id');
      return json(id ? (all[id] || null) : all);
    }
    if (request.method === 'PUT') {
      const item = await request.json();
      if (!item || !item.id) return json({ error: 'falta id' }, 400);
      all[item.id] = { ts: Date.now(), report: item.report };
      await kv.put(KEY, JSON.stringify(all));
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
      if (url.searchParams.get('all')) { await kv.put(KEY, '{}'); return json({ ok: true }); }
      const id = url.searchParams.get('id');
      if (id) { delete all[id]; await kv.put(KEY, JSON.stringify(all)); }
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
