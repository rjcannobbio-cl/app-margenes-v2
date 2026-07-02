/* ============================================================
   Cloudflare Pages Function — SINCRONIZAR catálogo desde ProfitGuard.

   Ruta: POST /api/pg-sync
     Baja /api/v1/product_sourcings (todas las páginas) usando la API key
     secreta PG_API_KEY, y arma una fila por combinación SKU + proveedor + puerto
     con el FOB real (USD). Escribe el catálogo en KV (clave 'catalog').

   NO calcula el COGS aquí: el COGS lo simula la app con el FOB + el factor CBM
   y el dólar de los parámetros del equipo. Acá solo traemos el FOB real.

   Campos que vienen del Excel / edición (dimensiones, precios Full/AON/DOD,
   comisión/categoría) se PRESERVAN: se copian desde el catálogo anterior
   (por id de sourcing, y como respaldo por SKU).

   Requisitos (Cloudflare → Settings → Variables and Secrets):
     - Secret  PG_API_KEY   = API key de ProfitGuard dedicada para la app.
     - Binding MARGENES_KV  = KV namespace (el mismo del resto).
   ============================================================ */

const PG = 'https://app.profitguard.cl/api/v1';

export async function onRequest({ request, env }) {
  const kv = env.MARGENES_KV;
  if (!kv) return json({ error: 'KV no configurado (binding MARGENES_KV)' }, 501);
  const country = new URL(request.url).searchParams.get('country') === 'co' ? 'co' : 'cl';
  const KEY = country === 'co' ? 'catalog_co' : 'catalog';
  // Secret de PG por país (Cloudflare a veces no permite guiones → varios alias).
  const token = country === 'co'
    ? (env['app-margenes-pg-api-key-co'] || env.app_margenes_pg_api_key_co || env.APP_MARGENES_PG_API_KEY_CO || env.PG_API_KEY_CO)
    : (env['app-margenes-pg-api-key'] || env.app_margenes_pg_api_key || env.APP_MARGENES_PG_API_KEY || env.PG_API_KEY);
  if (!token) return json({ error: 'Falta el secret de la API key de ProfitGuard para ' + (country === 'co' ? 'Colombia (app-margenes-pg-api-key-co)' : 'Chile (app-margenes-pg-api-key)') }, 501);
  if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);

  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  try {
    // Modo diagnóstico: POST /api/pg-sync?inspect=1 → muestra los campos de un producto (para verificar dims).
    if (new URL(request.url).searchParams.get('inspect')) {
      const r = await fetch(`${PG}/products?page=1&page_size=2`, { headers });
      const j = await r.json().catch(() => ({}));
      const arr = j.items || j.data || [];
      return json({ status: r.status, sampleKeys: arr[0] ? Object.keys(arr[0]) : null, sample: arr[0] || null });
    }

    // 1) Traer TODOS los sourcings (≈6 páginas de 100).
    const sourcings = [];
    for (let page = 1; page <= 60; page++) {
      const r = await fetch(`${PG}/product_sourcings?page=${page}&page_size=100`, { headers });
      if (!r.ok) {
        const detail = (await r.text().catch(() => '')).slice(0, 300);
        return json({ error: `ProfitGuard respondió ${r.status}`, detail }, 502);
      }
      const j = await r.json();
      const items = j.items || j.data || [];
      items.forEach(s => sourcings.push(s));
      const totalPages = (j.meta && j.meta.total_pages) || 1;
      if (page >= totalPages) break;
    }

    // 1b) Traer TODOS los productos → mapa de dimensiones por id de producto.
    //     PG expone alto/ancho/largo/peso en /products (no en product_sourcings).
    const dimsById = {};
    for (let page = 1; page <= 60; page++) {
      const r = await fetch(`${PG}/products?page=${page}&page_size=100`, { headers });
      if (!r.ok) break;   // si /products falla, se sigue con las dims preservadas
      const j = await r.json();
      const arr = j.items || j.data || [];
      for (const p of arr) {
        if (p && p.id != null) dimsById[p.id] = {
          alto: p.height != null ? p.height : '',
          ancho: p.width != null ? p.width : '',
          largo: p.length != null ? p.length : '',
          peso: p.weight != null ? p.weight : ''
        };
      }
      const totalPages = (j.meta && j.meta.total_pages) || 1;
      if (page >= totalPages) break;
    }

    // 2) Catálogo anterior → preservar campos manuales (dims, precios, comisión).
    const prev = JSON.parse((await kv.get(KEY)) || '[]');
    const prevById = {};
    const prevBySku = {};
    for (const x of prev) {
      if (x.id) prevById[x.id] = x;
      if (x.sku && !prevBySku[x.sku]) prevBySku[x.sku] = x; // primer registro con dims/precios del SKU
    }
    const keep = (cur, sku, field, dflt) => {
      const a = cur[field];
      if (a !== undefined && a !== '' && a !== null) return a;
      const b = (prevBySku[sku] || {})[field];
      if (b !== undefined && b !== '' && b !== null) return b;
      return dflt;
    };

    // 3) Una fila por sourcing (combinación SKU + proveedor + puerto), con FOB real (USD).
    const items = sourcings.map(s => {
      const p = s.product || {};
      const sku = p.sku || '';
      const id = 'src' + s.id;
      const old = prevById[id] || {};
      const fobUsd = (s.unitCost && typeof s.unitCost.cents === 'number') ? s.unitCost.cents / 100 : 0;
      // Dimensiones: preferir las de PG (/products); si faltan, conservar las previas (Excel/edición).
      const dpg = dimsById[p.id] || {};
      const dim = f => (dpg[f] !== undefined && dpg[f] !== '' && dpg[f] !== null) ? dpg[f] : keep(old, sku, f, '');
      return {
        id,
        sku,
        titulo: p.name || old.titulo || '',
        proveedor: (s.provider && s.provider.name) || '',
        puerto: (s.port && s.port.name) || '',
        fob: fobUsd,                       // USD — el COGS se simula en la app
        active: p.active !== false,
        // dimensiones desde PG (respaldo: Excel/edición):
        alto: dim('alto'),
        ancho: dim('ancho'),
        largo: dim('largo'),
        peso: dim('peso'),
        // preservados (Excel / edición):
        precioFull: keep(old, sku, 'precioFull', ''),
        precioAON: keep(old, sku, 'precioAON', ''),
        precioDOD: keep(old, sku, 'precioDOD', ''),
        mlCatName: keep(old, sku, 'mlCatName', ''),
        mlComPct: keep(old, sku, 'mlComPct', 0),
        fblaCatName: keep(old, sku, 'fblaCatName', ''),
        fbComPct: keep(old, sku, 'fbComPct', 0),
        isSuper: old.isSuper || false
      };
    });

    await kv.put(KEY, JSON.stringify(items));
    const withDims = items.filter(x => x.alto && x.ancho && x.largo && x.peso).length;
    return json({ ok: true, sourcings: sourcings.length, items: items.length, productsWithDims: Object.keys(dimsById).length, itemsWithDims: withDims });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
