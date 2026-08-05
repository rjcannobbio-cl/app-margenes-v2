/* ============================================================
   Cloudflare Pages Function — lee un Google Sheet PÚBLICO como CSV.

   Para subir la respuesta de un proveedor desde un link (Sheets con el mismo
   formato del template) en vez de un .xlsx. El navegador no puede pegarle a
   docs.google.com por CORS; esta Function lo baja server-side (read-only) y
   devuelve el CSV para que el front lo parsee con SheetJS (mismo parser).

   Ruta: GET /api/sheet-read?url=<link del Google Sheet>
     → { ok, csv } | { error }

   Requisito: el Sheet debe estar compartido como "Cualquier persona con el
   enlace: Lector" (o publicado). Si es privado, Google devuelve HTML de login
   y se responde 403 con instrucciones.
   ============================================================ */

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const link = (url.searchParams.get('url') || '').trim();
  if (!link) return json({ error: 'Falta el parámetro url' }, 400);

  // Extrae el ID del spreadsheet y (opcional) el gid de la pestaña.
  const m = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return json({ error: 'No parece un link de Google Sheets (falta /spreadsheets/d/…).' }, 400);
  const id = m[1];
  let gid = '0';
  const gm = link.match(/[#&?]gid=(\d+)/);
  if (gm) gid = gm[1];

  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  try {
    const r = await fetch(exportUrl, { redirect: 'follow', headers: { Accept: 'text/csv,*/*' } });
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) return json({ error: 'El Sheet no es público. Compártelo como “Cualquier persona con el enlace: Lector”.' }, 403);
      return json({ error: 'Google respondió ' + r.status }, 502);
    }
    // Si no es público, Google devuelve una página HTML (login/permiso) en vez del CSV.
    if (/text\/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
      return json({ error: 'El Sheet no es público. Compártelo como “Cualquier persona con el enlace: Lector”.' }, 403);
    }
    return json({ ok: true, csv: text, id, gid });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
