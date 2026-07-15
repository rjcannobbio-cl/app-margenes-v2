/* ============================================================
   Cloudflare Pages Function — passthrough READ-ONLY a Mercado Libre vía ProfitGuard.

   El análisis P2 (investigación de una categoría) necesita datos de ML
   (best-sellers, fichas de producto, reseñas). ML pide auth, y el token vive en
   ProfitGuard (secreto, del lado del servidor). Esta Function reenvía un GET a ML
   usando el passthrough de PG, para una lista ACOTADA de rutas de solo lectura.

   Ruta: POST /api/ml   body { path, query? }   (?country=co no soportado aún)
     path debe empezar por una de las rutas permitidas (allowlist).
   Devuelve el body de la respuesta de ML (o { error }).

   Requiere el mismo secreto que pg-sync (PG API key de la app, Chile).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';
const ML_INTEGRATION_CL = 1;
// Solo lectura y solo lo que P2 necesita.
const ALLOW = ['/highlights/', '/products/', '/reviews/', '/categories/', '/sites/'];

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
  const url = new URL(request.url);
  const country = url.searchParams.get('country') === 'co' ? 'co' : 'cl';
  if (country === 'co') return json({ error: 'ML passthrough aún no configurado para Colombia (falta integration_id CO)' }, 501);

  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);

  let bodyIn;
  try { bodyIn = await request.json(); } catch (e) { return json({ error: 'body inválido' }, 400); }
  const path = (bodyIn && bodyIn.path || '').toString();
  const query = (bodyIn && bodyIn.query) || {};
  if (!path.startsWith('/')) return json({ error: 'path debe empezar con /' }, 400);
  if (!ALLOW.some(p => path.startsWith(p))) return json({ error: 'ruta no permitida: ' + path }, 403);

  try {
    const r = await fetch(`${PG}/integrations/${ML_INTEGRATION_CL}/passthrough`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path, query })
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return json({ error: `ProfitGuard ${r.status}`, detail: j }, 502);
    // El passthrough devuelve { method, path, status, body }. Entregamos el body de ML.
    const status = (j && j.status) || 200;
    const mlBody = j && (j.body != null ? j.body : j);
    return json({ status, body: mlBody });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
