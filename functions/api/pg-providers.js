/* ============================================================
   Cloudflare Pages Function — lista de proveedores de ProfitGuard.
   Para los dropdowns y filtros de la pestaña Cotizaciones.

   Ruta: GET /api/pg-providers  → { ok, providers:[{id, name}] }
   Cachea en KV (clave pg_providers) por 6 h para no pegarle a PG en cada carga.
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';
const TTL = 6 * 3600 * 1000;

export async function onRequestGet({ request, env }) {
  const kv = env.MARGENES_KV;
  const token = env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY;
  if (!token) return json({ error: 'Falta el secret de ProfitGuard (app-margenes-pg-api-key)' }, 501);

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  if (kv && !force) { try { const c = JSON.parse((await kv.get('pg_providers')) || 'null'); if (c && c.ts && (Date.now() - c.ts < TTL)) return json({ ok: true, providers: c.providers, cached: true }); } catch (e) {} }

  try {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const seen = new Set(), providers = [];
    for (let page = 1; page <= 30; page++) {
      const r = await fetch(`${PG}/providers?page=${page}&page_size=100`, { headers });
      if (!r.ok) { if (page === 1) return json({ error: 'ProfitGuard ' + r.status }, 502); break; }
      const j = await r.json();
      const items = j.items || j.data || (Array.isArray(j) ? j : []);
      for (const p of items) {
        const id = p.id != null ? p.id : (p.providerId != null ? p.providerId : null);
        const name = (p.name || p.fantasyName || p.legalName || p.businessName || p.razonSocial || (id != null ? ('#' + id) : '')).toString().trim();
        if (id == null || seen.has(id)) continue;
        seen.add(id); providers.push({ id, name: name || ('#' + id) });
      }
      const tp = (j.meta && j.meta.total_pages) || 1;
      if (!items.length || page >= tp) break;
    }
    providers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if (kv) { try { await kv.put('pg_providers', JSON.stringify({ ts: Date.now(), providers })); } catch (e) {} }
    return json({ ok: true, providers });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
