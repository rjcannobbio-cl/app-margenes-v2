/* ============================================================
   Cloudflare Pages Function — CRON (refresco automático de datos PG/ML).

   Cloudflare Pages no tiene Cron Triggers propios (eso es de Workers), así que
   un disparador externo (el Worker con cron que ya tiene el equipo, o cron-job.org)
   llama a este endpoint cada pocos minutos. Como los refrescos son largos y con
   rate-limit de ML, cada llamada hace UNA sola tanda (un lote) y guarda el avance
   en KV (cron_state). Reusa la lógica existente via subrequest a los propios
   endpoints (/api/pg-sync, /api/track).

   Ruta: GET|POST /api/cron?key=SECRETO          → avanza una tanda
         GET      /api/cron?key=SECRETO&status=1 → solo informa el estado (no avanza)

   Ciclo (por tandas): [catálogo → productos D]diario → métricas → visitas → full/ads → idle.
   Cuando termina, espera CYCLE_MS antes de arrancar otro ciclo.

   Config (Cloudflare → Settings → Variables and Secrets):
     - Secret  cron-key   = clave para autorizar las llamadas del disparador.
     - Binding MARGENES_KV = el mismo KV del resto.
   Solo Chile (como track/pg-sync).
   ============================================================ */

// (redeploy para que las Functions tomen el secret cron-key recién creado)
const CYCLE_MS = 2.5 * 3600 * 1000;   // arranca un ciclo nuevo cada ~2,5 h
const DAY_MS = 24 * 3600 * 1000;      // catálogo + productos D: 1 vez al día

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const secret = env['cron-key'] || env.CRON_KEY || env.cron_key;
  if (!secret) return json({ error: 'Falta el secret cron-key (configúralo en Cloudflare)' }, 501);
  const key = url.searchParams.get('key') || request.headers.get('x-cron-key') || '';
  if (key !== secret) return json({ error: 'no autorizado' }, 403);

  const now = Date.now();
  const origin = url.origin;
  const st = JSON.parse((await kv.get('cron_state')) || 'null') || { phase: 'idle', offset: 0, lastCatalog: 0, lastCycleDone: 0, lastRun: 0, lastStep: null };
  st.lastRun = now;

  // Solo estado (para monitoreo desde el navegador / dashboard).
  if (url.searchParams.get('status')) {
    const nextCycleInMin = st.phase === 'idle' ? Math.max(0, Math.round((CYCLE_MS - (now - st.lastCycleDone)) / 60000)) : 0;
    return json({ ok: true, status: true, state: st, nextCycleInMin });
  }

  // Subrequest a los propios endpoints (reusa la lógica existente).
  const post = async (path, body) => {
    try {
      const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, j };
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  };
  const advanced = r => r.ok && r.j && r.j.ok;   // el lote se aplicó bien
  const save = async did => { st.lastStep = did; await kv.put('cron_state', JSON.stringify(st)); return json({ ok: true, did, state: st }); };

  try {
    // ---- Arranque de ciclo (desde idle) ----
    if (st.phase === 'idle') {
      if (now - st.lastCycleDone < CYCLE_MS) {
        return json({ ok: true, idle: true, nextCycleInMin: Math.max(0, Math.round((CYCLE_MS - (now - st.lastCycleDone)) / 60000)), state: st });
      }
      st.phase = (now - st.lastCatalog >= DAY_MS) ? 'catalog' : 'metrics';   // catálogo solo si toca (diario)
      st.offset = 0;
    }

    // ---- Una tanda por llamada ----
    if (st.phase === 'catalog') {
      const r = await post('/api/pg-sync', {});
      if (r.ok) { st.lastCatalog = now; st.phase = 'productsD'; st.offset = 0; }   // si falla, reintenta el catálogo la próxima
      return await save({ step: 'catalog', ok: r.ok });
    }
    if (st.phase === 'productsD') {
      const r = await post('/api/track', { action: 'refreshProducts' });
      if (advanced(r)) { st.phase = 'metrics'; st.offset = 0; }
      return await save({ step: 'productsD', ok: advanced(r) });
    }
    if (st.phase === 'metrics') {
      const r = await post('/api/track', { action: 'refreshMetrics', offset: st.offset, limit: 20 });
      if (advanced(r)) { const next = r.j.next; if (next == null) { st.phase = 'visits'; st.offset = 0; } else st.offset = next; }
      return await save({ step: 'metrics', offset: st.offset, ok: advanced(r) });
    }
    if (st.phase === 'visits') {
      const r = await post('/api/track', { action: 'refreshVisits', offset: st.offset, limit: 10 });
      if (advanced(r)) { const next = r.j.next; if (next == null) { st.phase = 'fullads'; st.offset = 0; } else st.offset = next; }
      return await save({ step: 'visits', offset: st.offset, ok: advanced(r) });
    }
    if (st.phase === 'fullads') {
      const r = await post('/api/track', { action: 'refreshFullAds', offset: st.offset, limit: 6 });
      if (advanced(r)) { const next = r.j.next; if (next == null) { st.phase = 'idle'; st.offset = 0; st.lastCycleDone = now; } else st.offset = next; }
      return await save({ step: 'fullads', offset: st.offset, ok: advanced(r) });
    }
    return await save({ step: 'noop' });
  } catch (e) {
    st.lastStep = { error: String((e && e.message) || e) };
    await kv.put('cron_state', JSON.stringify(st));
    return json({ error: String((e && e.message) || e), state: st }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
