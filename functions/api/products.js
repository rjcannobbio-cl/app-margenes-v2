/* ============================================================
   Cloudflare Pages Function — lista COMPARTIDA de productos evaluados.
   Proxy al Google Apps Script que guarda en un Google Sheet (Drive = "Excel"),
   una fila por producto. La URL del Apps Script vive en la variable de entorno
   SHEETS_WEBHOOK_URL (secreta); el navegador nunca la ve y se evita el CORS.

   Ruta: /api/products
     GET                 → array de productos (filas del Sheet)
     POST  {producto}    → agrega una fila
     DELETE ?id=<id>     → elimina la fila de ese id
     DELETE ?all=1       → vacía la hoja

   Si SHEETS_WEBHOOK_URL no está configurada, responde 501 y la app cae a la
   lista local del navegador (ver google-apps-script.gs y DEPLOY.md).
   ============================================================ */

export async function onRequest({ request, env }) {
  const target = env.SHEETS_WEBHOOK_URL;
  if (!target) return json({ error: 'SHEETS_WEBHOOK_URL no configurado' }, 501);

  const method = request.method;
  const url = new URL(request.url);
  try {
    if (method === 'GET') {
      const r = await fetch(target, { method: 'GET' });
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'POST') {
      const item = await request.json();
      return await forward(target, { action: 'add', item });
    }
    if (method === 'DELETE') {
      const payload = url.searchParams.get('all')
        ? { action: 'clear' }
        : { action: 'delete', id: url.searchParams.get('id') };
      return await forward(target, payload);
    }
    return json({ error: 'método no soportado' }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

async function forward(target, payload) {
  const r = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
