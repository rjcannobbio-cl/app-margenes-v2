/* ============================================================
   Cloudflare Pages Function — proveedores AGREGADOS a mano (no vienen de PG).
   Se usan en el dropdown de "Subir respuesta de proveedor" junto a los de PG.

   Ruta: /api/custom-providers   (country-aware con ?country=co)
     GET                 → { providers:[{id,name}] }
     POST { name }       → agrega (dedup por nombre normalizado) → { ok, provider, providers }
   Clave KV: custom_providers (CL) / custom_providers_co (CO).
   ============================================================ */

function keyFor(url) { return url.searchParams.get('country') === 'co' ? 'custom_providers_co' : 'custom_providers'; }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').trim();

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const url = new URL(request.url);
  const KEY = keyFor(url);
  try {
    if (request.method === 'GET') {
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      return json({ providers: list });
    }
    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const name = String((b && b.name) || '').trim().slice(0, 80);
      if (!name) return json({ error: 'Falta el nombre del proveedor' }, 400);
      const list = JSON.parse((await kv.get(KEY)) || '[]');
      let prov = list.find(p => norm(p.name) === norm(name));
      if (!prov) {
        prov = { id: 'custom:' + (norm(name).replace(/\s+/g, '-') || Math.random().toString(36).slice(2)), name };
        // evita colisión de id (dos nombres que normalizan igual pero ya existía otro): asegura unicidad
        if (list.some(p => String(p.id) === String(prov.id))) prov.id += '-' + list.length;
        list.push(prov);
        await kv.put(KEY, JSON.stringify(list));
      }
      return json({ ok: true, provider: prov, providers: list });
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
