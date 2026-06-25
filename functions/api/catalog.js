/* ============================================================
   Cloudflare Pages Function — CATÁLOGO compartido (KV, clave 'catalog').
   Un registro por combinación SKU + proveedor/FOB/puerto.

   Ruta: /api/catalog
     GET            → array de productos del catálogo
     PUT  [items]   → reemplaza TODO el catálogo (para la sincronización desde PG)
     POST {item}    → upsert de un item por id (para editar precios Full/AON/DOD)
     DELETE ?id     → elimina un item   |   DELETE ?all=1 → vacía

   Si MARGENES_KV no está configurado → 501 y la app usa catálogo local.
   ============================================================ */

const KEY = 'catalog';

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const url = new URL(request.url);
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
    return json({ error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
