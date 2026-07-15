/* ============================================================
   Cloudflare Pages Function — PROXY read-only al passthrough de ProfitGuard → ML.

   Lo usa la app (módulo Investigación) para saber en qué categorías hoja ya tiene
   ET Brands publicaciones ("Canibalización"): lista los ítems propios del seller y
   resuelve el category_id de cada uno. ML ya no permite consultas anónimas (401/403),
   así que hay que ir autenticado; el token vive sólo en el servidor.

   Ruta: POST /api/pg-passthrough   (country-aware con ?country=co)
     body { path, query } → reenvía GET a  POST {PG}/integrations/1/passthrough
                            con { method:'GET', path, query } y la key secreta de PG.

   Seguridad: read-only (siempre GET aguas arriba) y whitelist de paths (sólo los
   necesarios para canibalización). El token de PG NUNCA se expone al navegador.
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';

// Sólo estos paths (los que necesita el cálculo de canibalización).
const ALLOW = [
  /^\/users\/me$/,
  /^\/users\/\d+\/items\/search$/,
  /^\/items$/
];

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
  const country = new URL(request.url).searchParams.get('country') === 'co' ? 'co' : 'cl';
  const token = country === 'co'
    ? (env['app-margenes-pg-api-key-co'] || env.app_margenes_pg_api_key_co || env.APP_MARGENES_PG_API_KEY_CO || env.PG_API_KEY_CO)
    : (env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY);
  if (!token) return json({ error: 'Falta el secret de la API key de ProfitGuard' }, 501);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'body inválido' }, 400); }
  const path = body && typeof body.path === 'string' ? body.path : '';
  const query = (body && body.query && typeof body.query === 'object') ? body.query : {};
  if (!ALLOW.some(rx => rx.test(path))) return json({ error: 'path no permitido' }, 403);

  try {
    const r = await fetch(`${PG}/integrations/1/passthrough`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ method: 'GET', path, query })
    });
    const j = await r.json().catch(() => ({}));
    // Devuelve tal cual el passthrough de PG: { method, path, status, body, query }.
    return json(j, r.ok ? 200 : r.status);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
