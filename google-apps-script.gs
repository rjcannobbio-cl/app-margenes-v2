/* ============================================================
   ET Brands · Calculadora de Márgenes
   Backend de la "base de datos" en Google Drive (Google Sheet = Excel).
   Cada producto agregado a la comparación se guarda como una FILA.

   CÓMO INSTALARLO (una vez):
   1. Crea un Google Sheet nuevo en tu Drive (será la base de datos).
   2. En el Sheet: Extensiones → Apps Script.
   3. Borra el contenido y pega TODO este archivo. Guarda.
   4. Implementar → Nueva implementación → tipo "Aplicación web".
        - Ejecutar como: Yo
        - Quién tiene acceso: Cualquier persona
      Implementar → autoriza los permisos → copia la URL (termina en /exec).
   5. En Cloudflare (Pages → Settings → Variables and secrets) crea:
        SHEETS_WEBHOOK_URL = esa URL /exec   (como Secret)
      y haz Retry deployment.
   Listo: la lista queda compartida para el equipo y respaldada en tu Drive.
   El Sheet se puede descargar como Excel desde Archivo → Descargar → .xlsx.
   ============================================================ */

const SHEET_NAME = 'Productos';
const HEADERS = ['id', 'fecha', 'nombre', 'proveedor', 'cotizacion',
  'categoria_ml', 'comision_ml_%', 'precio_ml', 'margen_ml_$', 'margen_ml_%',
  'categoria_fala', 'comision_fala_%', 'precio_fala', 'margen_fala_$', 'margen_fala_%',
  'cogs', 'alto_cm', 'ancho_cm', 'largo_cm', 'peso_kg', 'fob_usd', 'dolar', 'factor_cbm', 'super'];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function itemToRow_(it) {
  return [it.id || '', it.fecha || '', it.nombre || '', it.proveedor || '', it.cotizacion || '',
    it.mlCatName || '', it.mlComPct || '', it.precioML || '', it.mlMargin || '', it.mlMarginPct || '',
    it.fblaCatName || '', it.fbComPct || '', it.precioFB || '', it.fbMargin || '', it.fbMarginPct || '',
    it.cogs || '', it.alto || '', it.ancho || '', it.largo || '', it.peso || '', it.fob || '',
    it.dolar || '', it.factorCBM || '', it.isSuper ? 'sí' : 'no'];
}

function num_(v) { return (typeof v === 'number') ? v : (parseFloat(String(v).replace(/[^0-9.\-]/g, '')) || 0); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// GET → devuelve todas las filas como array de objetos (para la app)
function doGet() {
  const sh = getSheet_();
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    const r = v[i];
    out.push({
      id: String(r[0]), fecha: r[1], nombre: r[2], proveedor: r[3], cotizacion: r[4],
      mlCatName: r[5], mlComPct: r[6], precioML: num_(r[7]), mlPrice: num_(r[7]), mlMargin: num_(r[8]), mlMarginPct: num_(r[9]),
      fblaCatName: r[10], fbComPct: r[11], precioFB: num_(r[12]), fbPrice: num_(r[12]), fbMargin: num_(r[13]), fbMarginPct: num_(r[14]),
      cogs: num_(r[15]), alto: num_(r[16]), ancho: num_(r[17]), largo: num_(r[18]), peso: num_(r[19]),
      fob: num_(r[20]), dolar: num_(r[21]), factorCBM: num_(r[22]), isSuper: r[23] === 'sí'
    });
  }
  return json_(out);
}

// POST → {action:'add', item} | {action:'delete', id} | {action:'clear'}
function doPost(e) {
  const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  const sh = getSheet_();
  if (body.action === 'add' && body.item) { sh.appendRow(itemToRow_(body.item)); return json_({ ok: true }); }
  if (body.action === 'delete' && body.id != null) {
    const n = Math.max(sh.getLastRow() - 1, 0);
    if (n > 0) {
      const ids = sh.getRange(2, 1, n, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(body.id)) sh.deleteRow(i + 2);
    }
    return json_({ ok: true });
  }
  if (body.action === 'clear') { if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); return json_({ ok: true }); }
  return json_({ error: 'acción no reconocida' });
}
