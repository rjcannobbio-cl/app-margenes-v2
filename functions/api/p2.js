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
      if (id) return json(all[id] || null);
      // ?index=1 → resumen liviano {catId: {ts, dif}} para la tabla (P2 sí/no + opportunity score), sin bajar los reportes completos.
      if (url.searchParams.get('index')) {
        const out = {};
        for (const k in all) {
          const r = all[k] || {}; const rep = r.report || {}; const ai = rep.ai || {};
          let conc = null;   // concentración = participación del vendedor #1 del ranking profundo (si existe)
          const ts2 = rep.deep && rep.deep.agg && rep.deep.agg.topSellers;
          if (Array.isArray(ts2) && ts2.length) { const tot = ts2.reduce((a, s) => a + (s.ventas || 0), 0); if (tot > 0) conc = (ts2[0].ventas || 0) / tot; }
          out[k] = { ts: r.ts || 0, dif: (typeof ai.difScore === 'number' ? ai.difScore : null), fit: (typeof ai.fitScore === 'number' ? ai.fitScore : null), conc };
        }
        return json(out);
      }
      return json(all);
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
