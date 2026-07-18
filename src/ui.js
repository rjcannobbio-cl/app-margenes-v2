/* ============================================================
   Interfaz — wiring del DOM, selección de categorías y comparación
   ============================================================ */
'use strict';

// País activo (Chile por defecto). Cada país tiene sus propios parámetros y base de datos.
let country = localStorage.getItem('mp_country') || 'cl';
const cfg = loadCfg(country);
const state = { mlCatIdx: -1, fblaCatIdx: -1, lastResult: null, arancelPct: 0, hs: '', editingStore: 'hist' };

const $ = (id) => document.getElementById(id);
const num = (id) => { const v = parseFloat($(id).value.replace(',', '.')); return isNaN(v) ? 0 : v; };
// Agrega ?country=co a las llamadas de API cuando el país activo es Colombia (Chile usa las claves originales).
function api(path) { const sep = path.includes('?') ? '&' : '?'; return country === 'co' ? path + sep + 'country=co' : path; }

/* ---------------- Selección de categorías ---------------- */
function catName(channel, i) {
  if (i < 0) return '';
  return channel === 'ml' ? ML_CATEGORIES[i].name : FBLA_CATEGORIES[i].name;
}
function catCost(channel, i) {
  if (i < 0) return null;
  return channel === 'ml' ? ML_CATEGORIES[i].cost : FBLA_CATEGORIES[i].cost;
}

function buildCatOptions(channel, filter) {
  const list = channel === 'ml' ? ML_CATEGORIES : FBLA_CATEGORIES;
  const sel = channel === 'ml' ? $('mlCatSelect') : $('fblaCatSelect');
  const curIdx = channel === 'ml' ? state.mlCatIdx : state.fblaCatIdx;
  const f = normalize(filter);
  const fToks = f.split(' ').filter(Boolean);

  let matches = [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i].name;
    if (!f) { matches.push(i); continue; }
    const nn = normalize(name) + ' ' + normalize(list[i].path || '');
    if (fToks.every(t => nn.includes(t))) matches.push(i);
  }
  // límite de render para performance
  const CAP = 400;
  let capped = matches.slice(0, CAP);
  if (curIdx >= 0 && !capped.includes(curIdx)) capped.unshift(curIdx);

  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '-1';
  ph.textContent = matches.length ? '— elegir categoría —' : '(sin coincidencias)';
  sel.appendChild(ph);

  for (const i of capped) {
    const o = document.createElement('option');
    o.value = String(i);
    const c = list[i].cost;
    o.textContent = list[i].path
      ? `${list[i].name}  ·  ${c}%   (${list[i].path})`
      : `${list[i].name}  ·  ${c}%`;
    if (i === curIdx) o.selected = true;
    sel.appendChild(o);
  }
  if (matches.length > CAP) {
    const o = document.createElement('option');
    o.value = '-1'; o.disabled = true;
    o.textContent = `… ${matches.length - CAP} más — escribe para filtrar`;
    sel.appendChild(o);
  }
}

let deduceToken = 0;   // guarda contra resultados de IA obsoletos (títulos que cambian rápido)

function deduceText() {
  return $('inpNombre').value.trim();
}

// Deducción local por palabras (fallback / sin API key)
function localDeduce(text) {
  const ml = deduceCategory(text, ML_CATEGORIES, 'name');
  const fb = deduceCategory(text, FBLA_CATEGORIES, 'name');
  if (ml.index >= 0) state.mlCatIdx = ml.index;
  if (fb.index >= 0) state.fblaCatIdx = fb.index;
  refreshCatUI();
  markDeduced('ml', ml.index >= 0, 'local');
  markDeduced('fbla', fb.index >= 0, 'local');
  recompute();
}

function refreshCatUI() {
  buildCatOptions('ml', ($('mlCatFilter') && $('mlCatFilter').value) || '');
  buildCatOptions('fbla', ($('fblaCatFilter') && $('fblaCatFilter').value) || '');
}

async function autoDeduce() {
  const text = deduceText();
  if (!text) return;
  // Usa IA si hay key pegada (dev) o si está servido por http(s) (en producción
  // existe el proxy /api/anthropic con la key oculta). En file:// sin key → keyword.
  const canUseAI = !!cfg.apiKey || location.protocol === 'http:' || location.protocol === 'https:';
  if (!canUseAI) {
    localDeduce(text);
    setAiStatus('Deducción local (abre la app por su URL o pega tu API key para usar IA).', false);
    return;
  }

  if (country === 'co') suggestHS();   // en paralelo: HS + arancel (Colombia)
  const myToken = ++deduceToken;
  markDeduced('ml', true, 'IA…'); markDeduced('fbla', true, 'IA…');
  setAiStatus('Consultando IA (Claude)…', false);
  try {
    const r = await aiSuggestBoth(text, cfg);
    if (myToken !== deduceToken) return;   // hubo un cambio más reciente
    // si la IA no dio match confiable en un canal, caer a deducción local en ese canal
    let mi = r.ml, fi = r.fbla, mlBy = 'IA', fbBy = 'IA';
    if (mi < 0) { mi = deduceCategory(text, ML_CATEGORIES, 'name').index; mlBy = 'local'; }
    if (fi < 0) { fi = deduceCategory(text, FBLA_CATEGORIES, 'name').index; fbBy = 'local'; }
    if (mi >= 0) state.mlCatIdx = mi;
    if (fi >= 0) state.fblaCatIdx = fi;
    refreshCatUI();
    markDeduced('ml', mi >= 0, mlBy); markDeduced('fbla', fi >= 0, fbBy);
    if (r.raw) console.log('[IA] respuesta:', r.raw);
    if (mlBy === 'IA' && fbBy === 'IA') {
      setAiStatus('Sugerido por IA ✓', false);
    } else {
      const rr = r.raw || {};
      setAiStatus('IA respondió ML="' + (rr.mlL1res || '?') + ' > ' + (rr.ml_hoja || '?') +
        '", Fbla="' + (rr.fbL1res || '?') + ' > ' + (rr.fbla_hoja || '?') + '". Algún canal usó deducción local.', false);
    }
    recompute();
  } catch (e) {
    if (myToken !== deduceToken) return;
    localDeduce(text);   // fallback
    setAiStatus('IA no disponible (' + e.message + '). Usé deducción local.', true);
  }
}

function setAiStatus(msg, isErr) {
  const el = $('aiStatus');
  el.textContent = msg;
  el.className = 'ai-status' + (isErr ? ' err' : '');
}

function markDeduced(channel, ok, label) {
  const el = channel === 'ml' ? $('mlCatBadge') : $('fblaCatBadge');
  if (label === 'IA…') { el.textContent = 'IA…'; el.className = 'badge badge-ai'; return; }
  if (!ok) { el.textContent = 'sin deducir'; el.className = 'badge badge-warn'; return; }
  if (label === 'IA') { el.textContent = 'IA'; el.className = 'badge badge-ai'; }
  else { el.textContent = 'auto'; el.className = 'badge badge-auto'; }
}

// Sugerencia de código HS + arancel (Colombia) vía IA; se puede corregir a mano.
async function suggestHS() {
  if (country !== 'co') return;
  const text = deduceText(); if (!text) return;
  const badge = $('hsBadge'); if (badge) { badge.textContent = 'IA…'; badge.className = 'badge badge-ai'; }
  try {
    const r = await aiSuggestHS(text, cfg);
    if (r.hs) { $('inpHs').value = r.hs; state.hs = r.hs; }
    if (r.arancel != null) { $('inpArancel').value = r.arancel; state.arancelPct = r.arancel; }
    if (badge) { badge.textContent = r.hs ? ('HS ' + r.hs + ' · ' + (r.arancel != null ? r.arancel + '%' : '?')) : 'IA'; badge.className = 'badge badge-ai'; }
    recompute();
  } catch (e) { if (badge) { badge.textContent = 'IA no disp.'; badge.className = 'badge badge-warn'; } }
}

/* ---------------- Cálculo y render ---------------- */
function recompute() {
  const alto = num('inpAlto'), ancho = num('inpAncho'), largo = num('inpLargo');
  const peso = num('inpPeso');
  const cbmUnit = (alto * ancho * largo) / 1000000;    // volumen por unidad (m³) desde dimensiones
  const fob = num('inpFob'), factorCBM = cfg.factorCBM, dolar = cfg.dolar;   // factor CBM y dólar viven en Parámetros
  const arancel = (country === 'co') ? num('inpArancel') : 0;   // arancel por producto (solo Colombia)
  state.arancelPct = arancel; state.hs = ($('inpHs') && $('inpHs').value.trim()) || '';
  const costo = computeLanded(fob, cbmUnit, factorCBM, dolar, cfg, arancel);   // landed cost = COGS
  $('landedVal').textContent = fmtCLP(costo);
  $('cbmInfo').textContent = 'CBM/u: ' + (cbmUnit > 0 ? cbmUnit.toFixed(5) : '–') + ' m³';
  const precioML = num('inpPrecioML'), precioFB = num('inpPrecioFB');
  const isSuper = $('inpSuper').checked;

  const weight = billableWeight(peso, alto, ancho, largo, VOL_DIVISOR);
  const vol = volumetricKg(alto, ancho, largo, VOL_DIVISOR);

  const comML = catCost('ml', state.mlCatIdx);
  const comFB = catCost('fbla', state.fblaCatIdx);

  const rML = computeChannel('ml', precioML, costo, comML || 0, weight, isSuper, cfg);
  const rFB = computeChannel('fbla', precioFB, costo, comFB || 0, weight, false, cfg);

  rML.weight = weight; rML.vol = vol; rML.catName = catName('ml', state.mlCatIdx); rML.catMissing = comML === null;
  rFB.weight = weight; rFB.vol = vol; rFB.catName = catName('fbla', state.fblaCatIdx); rFB.catMissing = comFB === null;
  rML.peso = peso; rFB.peso = peso;

  state.lastResult = { nombre: $('inpNombre').value.trim(), ml: rML, fbla: rFB };
  renderCard('ml', rML);
  renderCard('fbla', rFB);
}

function marginClass(pct) {
  if (pct >= 20) return 'm-good';
  if (pct >= 10) return 'm-mid';
  return 'm-bad';
}

function renderCard(channel, r) {
  const card = channel === 'ml' ? $('cardML') : $('cardFB');
  if (!r.valid) {
    card.innerHTML = `<div class="card-head ${channel}">${channel === 'ml' ? 'Mercado Libre' : 'Falabella'}</div>
      <div class="empty">Ingresa un precio de venta para ver el cálculo.</div>`;
    return;
  }
  const rows = [];
  rows.push(line('Precio de venta', fmtCLP(r.price), '100%', 'neutral'));
  rows.push(line('COGS (costo producto)', '− ' + fmtCLP(r.cogs), fmtPct(r.cogsPct), 'cost'));
  rows.push(line('Comisión ' + (r.catMissing ? '⚠️' : `(${fmtPct(r.comPct)})`), '− ' + fmtCLP(r.com), fmtPct(r.comPctOfPrice), 'cost'));
  rows.push(line('Costo de envío', '− ' + fmtCLP(r.ship), fmtPct(r.shipPct), 'cost'));

  const mc = marginClass(r.marginPct);
  const head = channel === 'ml' ? 'Mercado Libre' : 'Falabella';
  const notes = [];
  if (r.catMissing) notes.push('⚠️ Falta elegir categoría → comisión = 0%.');
  if (r.shipNote) notes.push('ℹ️ ' + r.shipNote);
  if (r.shipWarn) notes.push('⚠️ ' + r.shipWarn);

  card.innerHTML = `
    <div class="card-head ${channel}">${head} <span class="cat-used">${r.catName ? r.catName : 'sin categoría'}</span></div>
    <table class="restab">${rows.join('')}</table>
    <div class="margin-row ${mc}">
      <span>Margen</span>
      <span class="margin-vals"><b>${fmtCLP(r.margin)}</b><small>${fmtPct(r.marginPct)}</small></span>
    </div>
    <div class="ship-meta">Peso facturable: <b>${r.weight.toFixed(2)} kg</b>
      <span class="muted">(físico ${(r.peso||0).toFixed(2)} · volumétrico ${r.vol.toFixed(2)})</span></div>
    ${notes.length ? '<div class="notes">' + notes.map(n => `<div>${n}</div>`).join('') + '</div>' : ''}
  `;
}
function line(label, val, pct, cls) {
  return `<tr class="${cls}"><td>${label}</td><td class="v">${val}</td><td class="p">${pct}</td></tr>`;
}

/* ---------------- Comparación / historial (compartido vía Cloudflare KV, respaldo local) ---------------- */
const HIST_KEY = 'mphist';
let _histBackend = null;   // null=desconocido · true=API compartida · false=local
let viewList = [];         // lista EN PANTALLA (vista). El Excel/backend es la base de datos permanente.

// Trae la lista del backend (Excel) a la vista en pantalla.
async function loadView() {
  viewList = await histLoad();
  renderHist();
}

function localLoad() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; } }
function localSave(h) { localStorage.setItem(HIST_KEY, JSON.stringify(h)); }

async function histLoad() {
  if (_histBackend !== false) {
    try {
      const r = await fetch(api('/api/products'));
      if (r.ok) { _histBackend = true; return await r.json(); }
      _histBackend = false;
    } catch (e) { _histBackend = false; }
  }
  return localLoad();
}
async function histAdd(item) {
  if (_histBackend) {
    try { const r = await fetch(api('/api/products'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) }); if (r.ok) return; } catch (e) {}
  }
  const h = localLoad(); const i = h.findIndex(x => x.id === item.id);
  if (i >= 0) h[i] = item; else h.push(item);   // upsert por id
  localSave(h);
}
async function histDel(id) {
  if (_histBackend) {
    try { const r = await fetch(api('/api/products?id=' + encodeURIComponent(id)), { method: 'DELETE' }); if (r.ok) return; } catch (e) {}
  }
  localSave(localLoad().filter(x => x.id !== id));
}
async function histClear() {
  if (_histBackend) {
    try { const r = await fetch(api('/api/products?all=1'), { method: 'DELETE' }); if (r.ok) return; } catch (e) {}
  }
  localSave([]);
}
function newId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(16).slice(2)); }

/* ---------------- Parámetros COMPARTIDOS del equipo (KV) ---------------- */
// factor CBM, dólar, IVA y reputación Falabella iguales para todos (la API key es personal).
const SHARED_KEYS = ['factorCBM', 'dolar', 'iva', 'fblaRepIndex'];
async function settingsLoad() {
  try {
    const r = await fetch(api('/api/settings'));
    if (r.ok) {
      const s = await r.json();
      SHARED_KEYS.forEach(k => { if (s[k] != null && !isNaN(s[k])) cfg[k] = Number(s[k]); });
      return true;
    }
  } catch (e) {}
  return false;
}
async function settingsSave() {
  const payload = {};
  SHARED_KEYS.forEach(k => payload[k] = cfg[k]);
  _setSig = JSON.stringify(SHARED_KEYS.map(k => cfg[k]));
  try { await fetch(api('/api/settings'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
}

/* ---------------- Sincronización en vivo (sin recargar) ---------------- */
// ¿el usuario está editando los campos de Parámetros? (para no pisar lo que escribe)
function editingCfg() {
  const a = document.activeElement;
  return a && ['cfgFactorCBM', 'cfgDolar', 'cfgIva', 'cfgRep', 'cfgApiKey'].includes(a.id);
}
function applySharedSettings(s) {
  SHARED_KEYS.forEach(k => { if (s[k] != null && !isNaN(s[k])) cfg[k] = Number(s[k]); });
  saveCfg(cfg);
  $('cfgFactorCBM').value = cfg.factorCBM; $('cfgDolar').value = cfg.dolar;
  $('cfgIva').value = cfg.iva; $('cfgRep').value = String(cfg.fblaRepIndex);
  recompute(); renderHist();
  if (!$('tabHist').classList.contains('hidden')) paintHistorial();
  if (!$('tabCat').classList.contains('hidden')) paintCatalogo();
}
let _catSig = '';
// Consulta el servidor y actualiza si algo cambió (cada cierto tiempo y al volver a la pestaña).
async function liveTick() {
  if (document.hidden) return;
  try {
    const r = await fetch(api('/api/settings'));
    if (r.ok) {
      const s = await r.json();
      const sig = JSON.stringify(SHARED_KEYS.map(k => s[k]));
      if (sig !== _setSig) { _setSig = sig; if (!editingCfg()) applySharedSettings(s); }
    }
  } catch (e) {}
  if (!$('tabHist').classList.contains('hidden') && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#histDbWrap'))) {
    try {
      const r = await fetch(api('/api/products'));
      if (r.ok) {
        const list = await r.json();
        const sig = JSON.stringify(list);
        if (sig !== _histSig) { _histSig = sig; _histAll = list; paintHistorial(); }
      }
    } catch (e) {}
  }
  if (!$('tabCat').classList.contains('hidden') && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#catDbWrap'))) {
    try {
      const r = await fetch(api('/api/catalog'));
      if (r.ok) {
        const list = await r.json();
        const sig = JSON.stringify(list);
        if (sig !== _catSig) { _catSig = sig; _catAll = list; paintCatalogo(); }
      }
    } catch (e) {}
  }
  if (!$('tabClosed').classList.contains('hidden') && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#closedDbWrap'))) {
    try {
      const r = await fetch(api('/api/products?store=closed'));
      if (r.ok) {
        const list = await r.json();
        const sig = JSON.stringify(list);
        if (sig !== _closedSig) { _closedSig = sig; _closedAll = list; paintClosed(); }
      }
    } catch (e) {}
  }
  if (!$('tabResearch').classList.contains('hidden')) {
    try {
      const r = await fetch(api('/api/research'));
      if (r.ok) {
        const list = await r.json();
        const sig = JSON.stringify(list);
        if (sig !== _researchSig) { _researchSig = sig; _researchAll = list; paintResearch(); }
      }
    } catch (e) {}
  }
}

async function addToComparison() {
  const r = state.lastResult;
  if (!r || (!r.ml.valid && !r.fbla.valid)) { alert('Ingresa al menos un precio de venta primero.'); return; }
  const proveedor = $('inpProveedor').value.trim();
  if (!proveedor) { alert('El proveedor es obligatorio.'); $('inpProveedor').focus(); return; }
  const editing = state.editingId || null;
  const store = state.editingStore || 'hist';   // base de la que vino el producto en edición (hist / closed)
  const prevList = store === 'closed' ? _closedAll : _histAll;
  const prev = editing ? (prevList.find(v => v.id === editing) || viewList.find(v => v.id === editing) || {}) : {};
  // Parte del registro anterior (conserva Full/AON/DOD, SKU y Mes de cierre, etc.) y sobreescribe con el formulario.
  const item = Object.assign({}, prev, {
    id: editing || newId(), ts: Date.now(),
    fecha: new Date().toISOString().slice(0, 19).replace('T', ' '),
    nombre: r.nombre || '(sin nombre)', proveedor: proveedor, cotizacion: $('inpCotizacion').value.trim(), skuProveedor: $('inpSkuProv').value.trim(),
    alto: num('inpAlto'), ancho: num('inpAncho'), largo: num('inpLargo'), peso: num('inpPeso'), fob: num('inpFob'),
    precioML: num('inpPrecioML'), precioFB: num('inpPrecioFB'), isSuper: $('inpSuper').checked,
    mlCatIdx: state.mlCatIdx, mlCatName: r.ml.catName, mlComPct: r.ml.comPct,
    fblaCatIdx: state.fblaCatIdx, fblaCatName: r.fbla.catName, fbComPct: r.fbla.comPct,
    hs: state.hs, arancelPct: state.arancelPct,
    dolar: cfg.dolar, factorCBM: cfg.factorCBM,
    cogs: r.ml.cogs, mlPrice: r.ml.price, mlMargin: r.ml.margin, mlMarginPct: r.ml.marginPct,
    fbPrice: r.fbla.price, fbMargin: r.fbla.margin, fbMarginPct: r.fbla.marginPct
  });
  if (store === 'closed') {
    await closedAdd(item);   // actualiza el registro en Productos cerrados
    const ci = _closedAll.findIndex(v => v.id === item.id);
    if (ci >= 0) _closedAll[ci] = item; else _closedAll.push(item);
    _closedSig = '';
    if (!$('tabClosed').classList.contains('hidden')) renderClosed();
  } else {
    await histAdd(item);     // upsert en el Historial (KV)
    const vi = viewList.findIndex(v => v.id === item.id);
    if (vi >= 0) viewList[vi] = item; else viewList.push(item);   // y en la vista de comparación
    renderHist();
    if (!$('tabHist').classList.contains('hidden')) renderHistorial();
  }
  nuevoProducto();         // despeja el formulario para cargar el siguiente
  setAiStatus(editing ? (store === 'closed' ? '✓ Cambios guardados en Productos cerrados.' : '✓ Cambios guardados.') : '✓ Producto guardado.', false);
}

/* ---------------- Importar quote de proveedor (IA → Historial) ---------------- */
let _quoteData = null;
async function importQuoteFile(file) {
  if (!file) return;
  const st = $('quoteStatus');
  try {
    st.classList.remove('err'); st.textContent = 'Leyendo ' + file.name + '…';
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = quoteSheetToText(ws);
    if (!grid.trim()) { st.textContent = 'El Excel está vacío.'; st.classList.add('err'); return; }
    st.textContent = 'La IA está interpretando la cotización…';
    const data = await quoteAI(grid, file.name);
    if (!data || !Array.isArray(data.productos) || !data.productos.length) { st.textContent = 'No se pudieron extraer productos de la quote.'; st.classList.add('err'); return; }
    st.textContent = '';
    _quoteData = data;
    renderQuoteReview(data, file.name);
  } catch (e) { st.textContent = 'Error importando: ' + (e.message || e); st.classList.add('err'); }
}
// Hoja → grilla de texto compacta (solo filas con contenido) para la IA.
function quoteSheetToText(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const out = [];
  for (let i = 0; i < rows.length && out.length < 60; i++) {
    const cells = (rows[i] || []).map((v, c) => (v === '' || v == null) ? '' : (XLSX.utils.encode_col(c) + ':' + String(v).replace(/\s+/g, ' ').trim().slice(0, 40))).filter(Boolean);
    if (cells.length) out.push(cells.join(' | '));
  }
  return out.join('\n');
}
async function quoteAI(grid, filename) {
  const cfg = loadCfg(country);
  const prompt =
    'Eres asistente de importaciones de ET Brands. Te paso una COTIZACIÓN de un proveedor (grilla de celdas de un Excel; cada celda como COL:valor) y el nombre del archivo. Extrae CADA producto cotizado con sus datos normalizados.\n\n' +
    'ARCHIVO: ' + filename + '\n\nGRILLA:\n' + grid + '\n\n' +
    'Devuelve SOLO un JSON:\n' +
    '{"proveedor":"proveedor (del nombre del archivo o la quote)","cotizacion":"N° de cotización (ej N°548, del archivo)",' +
    '"productos":[{"nombre":"nombre corto y claro en español, máx 80 car","sku":"ITEM NO./código del proveedor o vacío","fob":<FOB USD número o null>,"alto":<cm por UNIDAD o null>,"ancho":<cm o null>,"largo":<cm o null>,"peso":<kg por unidad o null>,"precio":<precio de venta CLP si aparece, si no null>,"faltan":["campos requeridos que NO pudiste determinar con certeza"]}]}\n' +
    'REGLAS: dimensiones (cm) y peso (kg) son POR UNIDAD (caja/producto individual, NO el master carton). Si la quote solo trae CBM y PCS/CTN sin dimensiones por unidad, deja en null lo que falte y agrégalo a "faltan". Requeridos: fob, alto, ancho, largo, peso. Si un valor dice NA/Not Available/vacío → null y a "faltan". NO inventes números. Un producto por cada fila de producto real de la quote (ignora encabezados y filas vacías).';
  const raw = await aiText(prompt, cfg, { maxTokens: 2600 });
  return parseJSONLoose(raw);
}
function renderQuoteReview(data, filename) {
  $('quoteProv').value = data.proveedor || '';
  $('quoteCot').value = data.cotizacion || '';
  const req = ['fob', 'alto', 'ancho', 'largo', 'peso'];
  const miss = (p, k) => (p.faltan && p.faltan.includes(k)) || (req.includes(k) && (p[k] == null || p[k] === ''));
  const anyMissing = data.productos.some(p => req.some(k => miss(p, k)));
  $('quoteHint').innerHTML = anyMissing
    ? '⚠️ Faltan datos (celdas en rojo). Complétalos y aprieta “Importar al Historial”.'
    : 'Revisa que esté todo bien y aprieta “Importar al Historial”. Los márgenes se calculan solos si pones precio de venta.';
  const inp = (i, k, v, bad) => `<td><input type="${k === 'nombre' || k === 'sku' ? 'text' : 'number'}" data-i="${i}" data-k="${k}" value="${v == null ? '' : String(v).replace(/"/g, '&quot;')}" style="width:${k === 'nombre' ? '190' : k === 'sku' ? '90' : '68'}px;font-size:12px${bad ? ';border-color:var(--bad);background:rgba(239,68,68,.08)' : ''}"></td>`;
  const rows = data.productos.map((p, i) => `<tr>${inp(i, 'nombre', p.nombre)}${inp(i, 'sku', p.sku)}${inp(i, 'fob', p.fob, miss(p, 'fob'))}${inp(i, 'alto', p.alto, miss(p, 'alto'))}${inp(i, 'ancho', p.ancho, miss(p, 'ancho'))}${inp(i, 'largo', p.largo, miss(p, 'largo'))}${inp(i, 'peso', p.peso, miss(p, 'peso'))}${inp(i, 'precio', p.precio)}</tr>`).join('');
  $('quoteReview').innerHTML = `<table class="p2own" style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Producto</th><th>SKU</th><th>FOB US$</th><th>Alto cm</th><th>Ancho cm</th><th>Largo cm</th><th>Peso kg</th><th>Precio venta $</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('quoteTitle').textContent = data.productos.length + ' producto' + (data.productos.length === 1 ? '' : 's') + ' · ' + (filename || '');
  $('quoteCommitStatus').textContent = '';
  $('quoteOverlay').classList.remove('hidden');
}
async function commitQuote() {
  if (!_quoteData) return;
  const prods = _quoteData.productos.map(() => ({}));
  $('quoteReview').querySelectorAll('input[data-i]').forEach(el => { const i = +el.dataset.i, k = el.dataset.k; prods[i][k] = (k === 'nombre' || k === 'sku') ? el.value.trim() : (el.value === '' ? null : parseFloat(el.value)); });
  const req = ['fob', 'alto', 'ancho', 'largo', 'peso'];
  const bad = prods.filter(p => req.some(k => p[k] == null || isNaN(p[k]) || p[k] <= 0));
  if (bad.length) { $('quoteCommitStatus').innerHTML = '<span style="color:var(--bad)">Faltan FOB/dimensiones/peso en ' + bad.length + ' producto(s).</span>'; return; }
  const meta = { proveedor: $('quoteProv').value.trim(), cotizacion: $('quoteCot').value.trim() };
  $('quoteCommitStatus').textContent = 'Guardando…';
  let n = 0;
  for (const p of prods) { try { await histAdd(quoteRecord(p, meta)); n++; } catch (e) {} }
  _quoteData = null;
  $('quoteOverlay').classList.add('hidden');
  renderHist();
  showTab('hist'); renderHistorial();
  setAiStatus('✓ ' + n + ' producto(s) importados de la quote al Historial.', false);
}
// Arma un registro completo del Historial desde un producto de la quote (deduce categoría y calcula COGS/margen).
function quoteRecord(p, meta) {
  const alto = +p.alto || 0, ancho = +p.ancho || 0, largo = +p.largo || 0, peso = +p.peso || 0, fob = +p.fob || 0;
  const cbmUnit = (alto * ancho * largo) / 1e6;
  const cogs = computeLanded(fob, cbmUnit, cfg.factorCBM, cfg.dolar, cfg, '');
  const weight = billableWeight(peso, alto, ancho, largo, VOL_DIVISOR);
  const mi = deduceCategory(p.nombre || '', ML_CATEGORIES, 'name').index;
  const fi = deduceCategory(p.nombre || '', FBLA_CATEGORIES, 'name').index;
  const mlComPct = mi >= 0 ? (catCost('ml', mi) || 0) : 0, mlCatName = mi >= 0 ? catName('ml', mi) : '';
  const fbComPct = fi >= 0 ? (catCost('fbla', fi) || 0) : 0, fblaCatName = fi >= 0 ? catName('fbla', fi) : '';
  const precioML = +p.precio || 0;
  const rML = precioML ? computeChannel('ml', precioML, cogs, mlComPct, weight, false, cfg) : null;
  return {
    id: newId(), ts: Date.now(), fecha: new Date().toISOString().slice(0, 19).replace('T', ' '),
    nombre: (p.nombre || '(sin nombre)').slice(0, 120), proveedor: meta.proveedor || '', cotizacion: meta.cotizacion || '', skuProveedor: p.sku || '',
    alto, ancho, largo, peso, fob, precioML, precioFB: 0, isSuper: false,
    mlCatIdx: mi, mlCatName, mlComPct, fblaCatIdx: fi, fblaCatName, fbComPct,
    hs: '', arancelPct: '', dolar: cfg.dolar, factorCBM: cfg.factorCBM,
    cogs, mlPrice: precioML, mlMargin: rML ? rML.margin : null, mlMarginPct: rML ? rML.marginPct : null,
    fbPrice: 0, fbMargin: null, fbMarginPct: null, origen: 'quote'
  };
}

function resolveCatIdx(idx, name, list) {
  if (idx != null && idx >= 0 && list[idx] && list[idx].name === name) return idx;
  if (name) { for (let i = 0; i < list.length; i++) if (list[i].name === name) return i; }
  return (idx != null && idx >= 0) ? idx : -1;
}

// Click en una fila → recarga ese producto al formulario y recalcula el detalle.
// source: 'hist' (Historial, por defecto) o 'closed' (Productos cerrados) → define dónde se guardan los cambios.
function loadFromHist(x, source) {
  if (!x) return;
  state.editingStore = source || 'hist';
  const set = (id, v) => { $(id).value = (v || v === 0) ? v : ''; };
  $('inpNombre').value = (x.nombre && x.nombre !== '(sin nombre)') ? x.nombre : '';
  $('inpProveedor').value = x.proveedor || '';
  $('inpCotizacion').value = x.cotizacion || '';
  $('inpSkuProv').value = x.skuProveedor || '';
  set('inpAlto', x.alto); set('inpAncho', x.ancho); set('inpLargo', x.largo); set('inpPeso', x.peso); set('inpFob', x.fob);
  set('inpPrecioML', x.precioML); set('inpPrecioFB', x.precioFB);
  set('inpHs', x.hs); set('inpArancel', x.arancelPct);
  state.hs = x.hs || ''; state.arancelPct = x.arancelPct || 0;
  if ($('hsBadge')) { const has = x.hs || x.arancelPct; $('hsBadge').textContent = has ? ('HS ' + (x.hs || '?') + ' · ' + ((x.arancelPct || 0) + '%')) : 'sin deducir'; $('hsBadge').className = 'badge ' + (has ? 'badge-auto' : 'badge-warn'); }
  $('inpSuper').checked = !!x.isSuper;
  state.mlCatIdx = resolveCatIdx(x.mlCatIdx, x.mlCatName, ML_CATEGORIES);
  state.fblaCatIdx = resolveCatIdx(x.fblaCatIdx, x.fblaCatName, FBLA_CATEGORIES);
  refreshCatUI();
  markDeduced('ml', state.mlCatIdx >= 0, 'auto');
  markDeduced('fbla', state.fblaCatIdx >= 0, 'auto');
  setEditing(x.id || null);
  recompute();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Modo edición: al cargar un producto guardado, "Guardar" actualiza ESE registro.
function setEditing(id) {
  state.editingId = id || null;
  const badge = $('editBadge');
  if (state.editingId) {
    $('btnAdd').textContent = '💾 Guardar cambios';
    badge.textContent = state.editingStore === 'closed'
      ? 'Editando un producto cerrado — los cambios actualizan Productos cerrados.'
      : 'Editando un producto guardado — los cambios actualizan ese registro.';
    badge.style.display = '';
  } else {
    $('btnAdd').textContent = '+ Agregar / guardar';
    badge.textContent = ''; badge.style.display = 'none';
  }
}

// Limpia el formulario para empezar un producto nuevo.
function nuevoProducto() {
  ['inpNombre', 'inpProveedor', 'inpCotizacion', 'inpSkuProv', 'inpAlto', 'inpAncho', 'inpLargo', 'inpPeso', 'inpFob', 'inpPrecioML', 'inpPrecioFB', 'inpHs', 'inpArancel'].forEach(id => $(id).value = '');
  $('inpSuper').checked = false;
  state.mlCatIdx = -1; state.fblaCatIdx = -1; state.arancelPct = 0; state.hs = ''; state.editingStore = 'hist';
  if ($('hsBadge')) { $('hsBadge').textContent = 'sin deducir'; $('hsBadge').className = 'badge badge-warn'; }
  if ($('mlCatFilter')) $('mlCatFilter').value = ''; if ($('fblaCatFilter')) $('fblaCatFilter').value = '';
  refreshCatUI();
  markDeduced('ml', false); markDeduced('fbla', false);
  setEditing(null);
  setAiStatus('', false);
  recompute();
  $('inpNombre').focus();
}

// Recalcula los OUTPUTS de un registro desde sus inputs guardados + los parámetros
// ACTUALES (factor CBM, dólar, IVA). Así, al cambiar esos parámetros, todo el
// historial refleja los valores nuevos sin tener que volver a guardar cada producto.
function deriveOutputs(x) {
  const cbmUnit = ((x.alto || 0) * (x.ancho || 0) * (x.largo || 0)) / 1000000;
  const cogs = computeLanded(x.fob || 0, cbmUnit, cfg.factorCBM, cfg.dolar, cfg, x.arancelPct);
  const weight = billableWeight(x.peso || 0, x.alto || 0, x.ancho || 0, x.largo || 0, VOL_DIVISOR);
  const ml = computeChannel('ml', x.precioML || 0, cogs, x.mlComPct || 0, weight, !!x.isSuper, cfg);
  const fb = computeChannel('fbla', x.precioFB || 0, cogs, x.fbComPct || 0, weight, false, cfg);
  return {
    cogs, mlPrice: ml.price, mlMargin: ml.margin, mlMarginPct: ml.marginPct,
    fbPrice: fb.price, fbMargin: fb.margin, fbMarginPct: fb.marginPct
  };
}
function packSummary(x) {
  const d = [x.alto, x.largo, x.ancho].map(v => (v || v === 0) ? v : '–').join('×');
  return d + ' · ' + ((x.peso || x.peso === 0) ? x.peso : '–') + ' kg';
}
// Margen % en Mercado Libre para un precio arbitrario (para las columnas Precio Full / DOD del historial).
function histMlMarginPct(x, price) {
  const p = parseFloat(price) || 0;
  if (!p) return null;
  const cbmUnit = ((x.alto || 0) * (x.ancho || 0) * (x.largo || 0)) / 1000000;
  const cogs = computeLanded(x.fob || 0, cbmUnit, cfg.factorCBM, cfg.dolar, cfg, x.arancelPct);
  const weight = billableWeight(x.peso || 0, x.alto || 0, x.ancho || 0, x.largo || 0, VOL_DIVISOR);
  return computeChannel('ml', p, cogs, x.mlComPct || 0, weight, !!x.isSuper, cfg).marginPct;
}
const _histSavers = {};
function histSaveDebounced(item) { clearTimeout(_histSavers[item.id]); _histSavers[item.id] = setTimeout(() => histAdd(item), 600); }
// % de descuento entre dos precios (from → to): (from − to) / from.
function varPct(from, to) { const f = parseFloat(from) || 0, t = parseFloat(to) || 0; return (f > 0 && t > 0) ? (f - t) / f * 100 : null; }
function updateHistRow(tr, item) {
  const set = (key, v) => { const td = tr.querySelector(`[data-hcell="${key}"]`); if (!td) return; td.textContent = v == null ? '–' : fmtPct(v); td.className = 'mcell ' + (v == null ? '' : marginClass(v)); };
  set('full', histMlMarginPct(item, item.precioFull));
  set('aon', histMlMarginPct(item, item.precioAON));
  set('dod', histMlMarginPct(item, item.precioDOD));
  // %Var (solo existen en Productos cerrados; en Historial el querySelector no encuentra nada)
  const setPlain = (key, v) => { const td = tr.querySelector(`[data-hcell="${key}"]`); if (!td) return; td.textContent = v == null ? '–' : fmtPct(v); };
  setPlain('varfa', varPct(item.precioFull, item.precioAON));
  setPlain('varad', varPct(item.precioAON, item.precioDOD));
}

function renderHist() {
  const h = viewList;
  const wrap = $('histWrap');
  if (!h.length) { wrap.innerHTML = '<p class="muted">Aún no agregas productos a la comparación.</p>'; return; }
  const rows = h.map((x, i) => { const o = deriveOutputs(x); return `
    <tr data-i="${i}" title="Clic para cargar este producto">
      <td>${escapeHtml(x.nombre)}</td>
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${fmtCLP(o.cogs)}</td>
      <td>${fmtCLP(o.mlPrice)}</td>
      <td class="${marginClass(o.mlMarginPct)}">${fmtCLP(o.mlMargin)} · ${fmtPct(o.mlMarginPct)}</td>
      <td class="fbla-col">${fmtCLP(o.fbPrice)}</td>
      <td class="fbla-col ${marginClass(o.fbMarginPct)}">${fmtCLP(o.fbMargin)} · ${fmtPct(o.fbMarginPct)}</td>
      <td><button class="mini" data-del="${x.id || ''}" title="Quitar">✕</button></td>
    </tr>`; }).join('');
  wrap.innerHTML = `<table class="histtab">
    <thead><tr><th>Producto</th><th>Proveedor</th><th>COGS</th><th>Precio ML</th><th>Margen ML</th><th class="fbla-col">Precio Fala</th><th class="fbla-col">Margen Fala</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${_histBackend ? '' : '<p class="hint" style="margin-top:6px">Lista local de este navegador. Para compartirla con el equipo, configura Cloudflare KV (ver DEPLOY.md).</p>'}`;
  wrap.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('button')) return;
    loadFromHist(h[parseInt(tr.dataset.i, 10)]);
  });
  wrap.querySelectorAll('button[data-del]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.dataset.del;
    viewList = viewList.filter(x => x.id !== id);   // saca de la vista
    renderHist();
    await histDel(id);                              // y de la base de datos (Excel)
  });
}

function exportCSV() {
  const h = viewList;
  if (!h.length) { alert('No hay nada que exportar.'); return; }
  const head = ['Producto','Proveedor','Cotización','COGS','Precio ML','Margen ML $','Margen ML %','Precio Falabella','Margen Falabella $','Margen Falabella %'];
  const q = s => '"' + (s || '').toString().replace(/"/g, '""') + '"';
  const lines = [head.join(';')];
  for (const x of h) {
    const o = deriveOutputs(x);
    lines.push([
      q(x.nombre), q(x.proveedor), q(x.cotizacion),
      Math.round(o.cogs), Math.round(o.mlPrice), Math.round(o.mlMargin), (o.mlMarginPct || 0).toFixed(1).replace('.', ','),
      Math.round(o.fbPrice), Math.round(o.fbMargin), (o.fbMarginPct || 0).toFixed(1).replace('.', ',')
    ].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'comparacion_margenes.csv';
  a.click();
}
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* ---------------- Pestañas + Historial (base de datos) ---------------- */
function showTab(name) {
  $('tabCalc').classList.toggle('hidden', name !== 'calc');
  $('tabHist').classList.toggle('hidden', name !== 'hist');
  $('tabCat').classList.toggle('hidden', name !== 'cat');
  $('tabClosed').classList.toggle('hidden', name !== 'closed');
  $('tabResearch').classList.toggle('hidden', name !== 'research');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'hist') renderHistorial();
  if (name === 'cat') renderCatalogo();
  if (name === 'closed') renderClosed();
  if (name === 'research') renderResearch();
}

function compositeId(x) {
  return [x.nombre, x.proveedor, x.cotizacion, x.skuProveedor]
    .map(s => (s == null ? '' : s).toString().trim()).filter(Boolean).join(' · ');
}

let _histAll = [];
let _histSig = '', _setSig = '';   // firmas para detectar cambios en la sincronización en vivo
let packExpanded = false;   // packaging (alto/largo/ancho/peso) agrupado por defecto

async function renderHistorial() {
  _histAll = await histLoad();
  _histSig = JSON.stringify(_histAll);
  paintHistorial();
}
function paintHistorial() { paintDb('hist'); }
function paintClosed() { paintDb('closed'); }
// Render genérico de la tabla base de datos: 'hist' (Historial) y 'closed' (Productos cerrados) comparten columnas.
function paintDb(mode) {
  const isClosed = mode === 'closed';
  const all = isClosed ? _closedAll : _histAll;
  const ids = isClosed ? { filter: 'closedFilter', count: 'closedCount', wrap: 'closedDbWrap' } : { filter: 'histFilter', count: 'histCount', wrap: 'histDbWrap' };
  const rerender = isClosed ? renderClosed : renderHistorial;
  const save = isClosed ? closedSaveDebounced : histSaveDebounced;
  const q = normalize(($(ids.filter) && $(ids.filter).value) || '');
  const filtered = q
    ? all.filter(x => normalize([x.nombre, x.skuProveedor, x.skuCierre, x.sku, x.proveedor, x.cotizacion].join(' ')).includes(q))
    : all;
  $(ids.count).textContent = (q ? (filtered.length + '/' + all.length) : all.length) +
    ' producto' + ((q ? filtered.length : all.length) === 1 ? '' : 's') + (_histBackend ? ' · compartido' : ' · solo local');
  const wrap = $(ids.wrap);
  if (!all.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">' + (isClosed ? 'Aún no hay productos cerrados. Ciérralos desde el Historial con el botón “Cerrar”.' : 'Aún no hay productos evaluados. Agrégalos desde la pestaña Calculadora.') + '</p>'; return; }
  if (!filtered.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Sin resultados para “' + escapeHtml($(ids.filter).value) + '”.</p>'; return; }
  const cell = v => (v || v === 0) ? v : '';
  const hprice = (x, field) => `<td><input type="number" class="hist-price" data-id="${x.id || ''}" data-field="${field}" value="${x[field] || ''}" placeholder="–" min="0" step="1"></td>`;
  const hmarg = (key, v) => `<td class="mcell ${v == null ? '' : marginClass(v)}" data-hcell="${key}">${v == null ? '–' : fmtPct(v)}</td>`;
  const actionCell = x => isClosed
    ? `<td style="white-space:nowrap"><button class="mini" data-reopen="${x.id || ''}" title="Devolver al Historial">↩</button> <button class="mini" data-del="${x.id || ''}" title="Eliminar definitivamente">✕</button></td>`
    : `<td style="white-space:nowrap"><button class="btn-close" data-close="${x.id || ''}" type="button">Comprar producto</button> <button class="mini" data-del="${x.id || ''}" title="Eliminar del historial">✕</button></td>`;
  // %Var solo en Productos cerrados: descuento Full→AON y AON→DOD.
  const varHead = isClosed ? '<th>%Var Full-AON</th><th>%Var AON-DOD</th>' : '';
  const varCells = x => isClosed
    ? `<td data-hcell="varfa">${fmtPct(varPct(x.precioFull, x.precioAON))}</td><td data-hcell="varad">${fmtPct(varPct(x.precioAON, x.precioDOD))}</td>`
    : '';
  // Datos del cierre (SKU + Mes), solo en Productos cerrados.
  const closedInfoHead = isClosed ? '<th>SKU cierre</th><th>Mes cierre</th><th>Año cierre</th>' : '';
  const closedInfoCells = x => isClosed ? `<td>${escapeHtml(x.skuCierre || '')}</td><td>${escapeHtml(x.mesCierre || '')}</td><td>${escapeHtml(x.anioCierre || '')}</td>` : '';

  const packHead = packExpanded
    ? `<th class="pack-toggle" title="Agrupar packaging">📦 ◂ Alto</th><th>Largo</th><th>Ancho</th><th>Peso</th>`
    : `<th class="pack-toggle" title="Expandir packaging">📦 Packaging ▸</th>`;
  const packCells = x => packExpanded
    ? `<td>${cell(x.alto)}</td><td>${cell(x.largo)}</td><td>${cell(x.ancho)}</td><td>${cell(x.peso)}</td>`
    : `<td>${escapeHtml(packSummary(x))}</td>`;

  const rows = filtered.map((x, i) => { const o = deriveOutputs(x); return `
    <tr data-i="${i}" title="Clic para cargar este producto en la calculadora">
      <td>${escapeHtml(compositeId(x))}</td>
      <td>${escapeHtml(x.nombre || '')}</td>
      ${closedInfoCells(x)}
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${escapeHtml(x.cotizacion || '')}</td>
      ${packCells(x)}
      <td>${x.fob ? ('US$' + x.fob) : ''}</td>
      <td>${fmtCLP(o.cogs)}</td>
      <td>${x.isSuper ? 'Sí' : 'No'}</td>
      <td>${escapeHtml(x.mlCatName || '')}</td>
      <td class="co-only"><input type="text" class="hist-hs" data-id="${x.id || ''}" value="${escapeHtml(x.hs || '')}" placeholder="–" style="width:88px"></td>
      <td class="co-only"><input type="number" class="hist-ar" data-id="${x.id || ''}" value="${(x.arancelPct || x.arancelPct === 0) ? x.arancelPct : ''}" placeholder="0" min="0" step="0.1" style="width:60px"></td>
      <td>${fmtCLP(o.mlPrice)}</td>
      <td class="${marginClass(o.mlMarginPct)}">${fmtPct(o.mlMarginPct)}</td>
      <td class="fbla-col">${fmtCLP(o.fbPrice)}</td>
      <td class="fbla-col ${marginClass(o.fbMarginPct)}">${fmtPct(o.fbMarginPct)}</td>
      ${hprice(x, 'precioFull')}${hmarg('full', histMlMarginPct(x, x.precioFull))}
      ${hprice(x, 'precioAON')}${hmarg('aon', histMlMarginPct(x, x.precioAON))}
      ${hprice(x, 'precioDOD')}${hmarg('dod', histMlMarginPct(x, x.precioDOD))}
      ${varCells(x)}
      ${actionCell(x)}
    </tr>`; }).join('');
  wrap.innerHTML = `<table class="histtab dbtab"><thead><tr>
    <th>ID</th><th>Nombre producto</th>${closedInfoHead}<th>Proveedor</th><th>N° Cotización</th>
    ${packHead}<th>Costo FOB</th><th>Landed COGS</th>
    <th>Súper</th><th>Categoría ML</th><th class="co-only">HS</th><th class="co-only">Arancel %</th><th>Precio Meli</th><th>Margen Meli</th><th class="fbla-col">Precio Fala</th><th class="fbla-col">Margen Fala</th>
    <th>Precio Full</th><th>Margen Full</th><th>Precio AON</th><th>Margen AON</th><th>Precio DOD</th><th>Margen DOD</th>${varHead}<th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;

  const toggle = wrap.querySelector('.pack-toggle');
  if (toggle) toggle.onclick = (e) => { e.stopPropagation(); packExpanded = !packExpanded; rerender(); };
  wrap.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('button') || e.target.closest('.pack-toggle') || e.target.closest('input')) return;
    showTab('calc'); loadFromHist(filtered[parseInt(tr.dataset.i, 10)], mode);
  });
  // Precio Full / DOD editables → recalculan su margen (Meli) y persisten en la base del país.
  wrap.querySelectorAll('input.hist-price').forEach(inp => inp.addEventListener('input', () => {
    const item = all.find(x => x.id === inp.dataset.id);
    if (!item) return;
    item[inp.dataset.field] = inp.value === '' ? '' : (parseFloat(inp.value) || 0);
    updateHistRow(inp.closest('tr'), item);
    save(item);
  }));
  // HS (texto) → solo persiste. Arancel % → recalcula todo (afecta el COGS) y persiste.
  wrap.querySelectorAll('input.hist-hs').forEach(inp => inp.addEventListener('change', () => {
    const item = all.find(x => x.id === inp.dataset.id); if (!item) return;
    item.hs = inp.value.trim(); save(item);
  }));
  wrap.querySelectorAll('input.hist-ar').forEach(inp => inp.addEventListener('change', () => {
    const item = all.find(x => x.id === inp.dataset.id); if (!item) return;
    item.arancelPct = inp.value === '' ? '' : (parseFloat(inp.value) || 0);
    save(item); paintDb(mode);   // el arancel cambia el COGS y los márgenes
  }));
  wrap.querySelectorAll('button[data-close]').forEach(b => b.onclick = (e) => { e.stopPropagation(); closeProduct(all.find(x => x.id === b.dataset.close)); });
  wrap.querySelectorAll('button[data-reopen]').forEach(b => b.onclick = (e) => { e.stopPropagation(); reopenProduct(all.find(x => x.id === b.dataset.reopen)); });
  wrap.querySelectorAll('button[data-del]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿Eliminar este producto ' + (isClosed ? 'de Productos cerrados' : 'del historial') + (_histBackend ? ' (para todo el equipo)' : '') + '?')) return;
    await (isClosed ? closedDel(b.dataset.del) : histDel(b.dataset.del)); rerender();
  });
}

/* ---------------- Productos cerrados (base de datos propia por país) ---------------- */
const CLOSED_KEY = 'mpclosed';
let _closedAll = [], _closedSig = '';
function closedLocalLoad() { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]'); } catch (e) { return []; } }
function closedLocalSave(h) { localStorage.setItem(CLOSED_KEY, JSON.stringify(h)); }
async function closedLoad() {
  if (_histBackend !== false) {
    try { const r = await fetch(api('/api/products?store=closed')); if (r.ok) { _histBackend = true; return await r.json(); } _histBackend = false; } catch (e) { _histBackend = false; }
  }
  return closedLocalLoad();
}
async function closedAdd(item) {
  if (_histBackend) {
    try { const r = await fetch(api('/api/products?store=closed'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) }); if (r.ok) return; } catch (e) {}
  }
  const h = closedLocalLoad(); const i = h.findIndex(x => x.id === item.id); if (i >= 0) h[i] = item; else h.push(item); closedLocalSave(h);
}
async function closedDel(id) {
  if (_histBackend) {
    try { const r = await fetch(api('/api/products?store=closed&id=' + encodeURIComponent(id)), { method: 'DELETE' }); if (r.ok) return; } catch (e) {}
  }
  closedLocalSave(closedLocalLoad().filter(x => x.id !== id));
}
const _closedSavers = {};
function closedSaveDebounced(item) { clearTimeout(_closedSavers[item.id]); _closedSavers[item.id] = setTimeout(() => closedAdd(item), 600); }
async function renderClosed() {
  _closedAll = await closedLoad();
  _closedSig = JSON.stringify(_closedAll);
  paintClosed();
}
// Mueve un producto de Historial → Productos cerrados.
async function closeProduct(item) {
  if (!item) return;
  const r = await askConfirm('¿Estás seguro de que quieres comprar este producto?', 'Sí, comprar', true);
  if (!r) return;
  item.skuCierre = r.sku; item.mesCierre = r.mes; item.anioCierre = r.anio;   // datos del cierre
  await closedAdd(item);      // lo agrega a Cerrados
  await histDel(item.id);     // lo saca del Historial
  _histAll = _histAll.filter(x => x.id !== item.id);
  viewList = viewList.filter(x => x.id !== item.id);
  _histSig = ''; _closedSig = '';
  renderHist(); paintHistorial();
  if (!$('tabClosed').classList.contains('hidden')) renderClosed();
}
// Devuelve un producto de Cerrados → Historial.
async function reopenProduct(item) {
  if (!item) return;
  if (!confirm('¿Devolver este producto al Historial?')) return;
  await histAdd(item);
  await closedDel(item.id);
  _closedAll = _closedAll.filter(x => x.id !== item.id);
  _histSig = ''; _closedSig = '';
  paintClosed();
  if (!$('tabHist').classList.contains('hidden')) renderHistorial();
}
// Modal de confirmación reutilizable. Sin withFields → Promise<boolean>.
// Con withFields → pide SKU + Mes de cierre (obligatorios) y resuelve {sku, mes} o false.
function askConfirm(msg, okLabel, withFields) {
  return new Promise(res => {
    $('modalMsg').textContent = msg;
    $('modalOk').textContent = okLabel || 'Sí';
    const fields = $('modalFields');
    if (withFields) { $('modalSku').value = ''; $('modalMes').value = ''; $('modalAnio').value = ''; $('modalErr').textContent = ''; fields.classList.remove('hidden'); }
    else fields.classList.add('hidden');
    $('modalOverlay').classList.remove('hidden');
    if (withFields) setTimeout(() => $('modalSku').focus(), 30);
    const done = v => { $('modalOverlay').classList.add('hidden'); fields.classList.add('hidden'); $('modalOk').onclick = null; $('modalCancel').onclick = null; $('modalOverlay').onclick = null; res(v); };
    $('modalOk').onclick = () => {
      if (withFields) {
        const sku = $('modalSku').value.trim(), mes = $('modalMes').value, anio = $('modalAnio').value;
        if (!sku || !mes || !anio) { $('modalErr').textContent = 'Completa SKU, Mes y Año de cierre.'; return; }
        done({ sku, mes, anio });
      } else done(true);
    };
    $('modalCancel').onclick = () => done(false);
    $('modalOverlay').onclick = e => { if (e.target === $('modalOverlay')) done(false); };
  });
}

function exportHistorialCSV() { exportDbCSV(_histAll, 'historial_productos.csv'); }
function exportClosedCSV() { exportDbCSV(_closedAll, 'productos_cerrados.csv'); }
function exportDbCSV(h, filename) {
  if (!h.length) { alert('No hay productos que exportar.'); return; }
  const head = ['ID', 'Nombre', 'Proveedor', 'N° Cotización', 'Alto', 'Largo', 'Ancho', 'Peso', 'Costo FOB', 'HS', 'Arancel %', 'Landed COGS', 'Supermercado', 'Categoría ML', 'Precio Meli', 'Margen Meli %', 'Precio Fala', 'Margen Fala %', 'Precio Full', 'Margen Full %', 'Precio AON', 'Margen AON %', 'Precio DOD', 'Margen DOD %', '%Var Full-AON', '%Var AON-DOD', 'SKU cierre', 'Mes cierre', 'Año cierre'];
  const q = s => '"' + (s == null ? '' : s).toString().replace(/"/g, '""') + '"';
  const n = v => (v == null || isNaN(v)) ? '' : Math.round(v);
  const p = v => (v == null || isNaN(v)) ? '' : Number(v).toFixed(1).replace('.', ',');
  const lines = [head.join(';')];
  for (const x of h) {
    const o = deriveOutputs(x);
    lines.push([
      q(compositeId(x)), q(x.nombre), q(x.proveedor), q(x.cotizacion),
      (x.alto || ''), (x.largo || ''), (x.ancho || ''), (x.peso || ''), (x.fob || ''), q(x.hs), (x.arancelPct || x.arancelPct === 0 ? x.arancelPct : ''), n(o.cogs),
      x.isSuper ? 'Sí' : 'No', q(x.mlCatName), n(o.mlPrice), p(o.mlMarginPct), n(o.fbPrice), p(o.fbMarginPct),
      (x.precioFull || ''), p(histMlMarginPct(x, x.precioFull)), (x.precioAON || ''), p(histMlMarginPct(x, x.precioAON)), (x.precioDOD || ''), p(histMlMarginPct(x, x.precioDOD)), p(varPct(x.precioFull, x.precioAON)), p(varPct(x.precioAON, x.precioDOD)), q(x.skuCierre), q(x.mesCierre), q(x.anioCierre)
    ].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

/* ---------------- Catálogo (DB compartida + simulación en vivo) ---------------- */
const CAT_KEY = 'mpcat';
let _catBackend = null, _catAll = [];

function catLocalLoad() { try { return JSON.parse(localStorage.getItem(CAT_KEY) || '[]'); } catch (e) { return []; } }
function catLocalSave(h) { localStorage.setItem(CAT_KEY, JSON.stringify(h)); }
async function catLoad() {
  if (_catBackend !== false) {
    try { const r = await fetch(api('/api/catalog')); if (r.ok) { _catBackend = true; return await r.json(); } _catBackend = false; } catch (e) { _catBackend = false; }
  }
  return catLocalLoad();
}
async function catUpsert(item) {
  if (_catBackend) { try { const r = await fetch(api('/api/catalog'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) }); if (r.ok) return; } catch (e) {} }
  const h = catLocalLoad(); const i = h.findIndex(x => x.id === item.id); if (i >= 0) h[i] = item; else h.push(item); catLocalSave(h);
}

// Landed COGS + márgenes % a los 3 precios, con los parámetros ACTUALES (dólar, factor CBM).
function catMargins(x) {
  const cbmUnit = ((x.alto || 0) * (x.ancho || 0) * (x.largo || 0)) / 1000000;
  const cogs = computeLanded(x.fob || 0, cbmUnit, cfg.factorCBM, cfg.dolar, cfg, x.arancelPct);
  const weight = billableWeight(x.peso || 0, x.alto || 0, x.ancho || 0, x.largo || 0, VOL_DIVISOR);
  const m = price => {
    const p = parseFloat(price) || 0;
    if (!p) return { ml: null, fa: null };
    return {
      ml: computeChannel('ml', p, cogs, x.mlComPct || 0, weight, !!x.isSuper, cfg).marginPct,
      fa: computeChannel('fbla', p, cogs, x.fbComPct || 0, weight, false, cfg).marginPct
    };
  };
  return { cogs, full: m(x.precioFull), aon: m(x.precioAON), dod: m(x.precioDOD) };
}

// Índice nombre→entradas de la tabla local de categorías ML (para mapear la categoría real).
let _mlCatByName = null;
function mlCatIndex() {
  if (_mlCatByName) return _mlCatByName;
  _mlCatByName = new Map();
  (window.ML_CATEGORIES || []).forEach((c, i) => { const k = normalize(c.name); if (!_mlCatByName.has(k)) _mlCatByName.set(k, []); _mlCatByName.get(k).push(i); });
  return _mlCatByName;
}
// Dado el breadcrumb REAL de ML (["L1",…,"hoja"]), devuelve la comisión de la tabla local.
function commissionFromRealCat(pathNames) {
  if (!Array.isArray(pathNames) || !pathNames.length) return null;
  const leaf = pathNames[pathNames.length - 1], root = pathNames[0];
  const idxs = mlCatIndex().get(normalize(leaf));
  if (!idxs || !idxs.length) return null;
  let chosen = idxs[0];
  if (idxs.length > 1) { const byRoot = idxs.find(i => normalize((ML_CATEGORIES[i].path || '').split('>')[0]) === normalize(root)); if (byRoot != null) chosen = byRoot; }
  return { idx: chosen, name: ML_CATEGORIES[chosen].name, cost: ML_CATEGORIES[chosen].cost || 0 };
}
// Fija comisión/categoría ML desde la categoría REAL (post-sync). Devuelve cuántas mapeó.
function applyRealCatCommission(items) {
  let n = 0;
  for (const it of (items || [])) { if (!it.mlCatPathReal) continue; const c = commissionFromRealCat(it.mlCatPathReal); if (c) { it.mlCatName = c.name; it.mlComPct = c.cost; it.mlCatIdx = c.idx; n++; } }
  return n;
}
// Marca propia de ET Brands deducida del título (para el P2).
const ETB_BRANDS = ['Hosser', 'Zeker', 'Howell', 'Overfit', 'Duke', 'Ibrah Music', 'Ibrah', 'Colton', 'Galanta', 'Homely', 'Luxgear', 'Planex', 'Babynest'];
function ownBrandOf(title) { const t = normalize(title || ''); for (const b of ETB_BRANDS) { if (t.includes(normalize(b))) return b; } return ''; }

const _catSavers = {};
function catSaveDebounced(item) {
  clearTimeout(_catSavers[item.id]);
  _catSavers[item.id] = setTimeout(() => catUpsert(item), 600);
}

async function renderCatalogo() {
  _catAll = await catLoad();
  _catSig = JSON.stringify(_catAll);
  paintCatalogo();
}
// Carga un producto del Catálogo en la Calculadora para simular cambios (FOB, packaging, peso…).
// Sin id → se evalúa como producto nuevo (si se guarda, iría al Historial). Usa el Precio Full como precio de venta.
function loadCatalogItem(x) {
  if (!x) return;
  showTab('calc');
  loadFromHist({
    nombre: x.titulo, proveedor: x.proveedor, cotizacion: '', skuProveedor: x.sku,
    alto: x.alto, ancho: x.ancho, largo: x.largo, peso: x.peso, fob: x.fob,
    precioML: x.precioFull, precioFB: x.precioFull, isSuper: x.isSuper,
    mlCatName: x.mlCatName, mlComPct: x.mlComPct, fblaCatName: x.fblaCatName, fbComPct: x.fbComPct,
    hs: x.hs, arancelPct: x.arancelPct
  });
}
function setCatStatus(msg, isErr) {
  const el = $('catStatus'); if (!el) return;
  el.textContent = msg || ''; el.style.color = isErr ? 'var(--bad)' : 'var(--muted)';
}
// Reemplaza TODO el catálogo en el backend (o local).
async function catReplace(items) {
  if (_catBackend !== false) {
    try { const r = await fetch(api('/api/catalog'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items) }); if (r.ok) { _catBackend = true; return true; } _catBackend = false; } catch (e) { _catBackend = false; }
  }
  catLocalSave(items); return false;
}

// Sincroniza FOB / proveedor / puerto / dimensiones desde ProfitGuard (server-side, key secreta).
// El botón ya es la confirmación → sin popup. Conserva los precios y el arancel/HS editados a mano.
async function syncFromPG() {
  setCatStatus('Sincronizando con ProfitGuard… (FOB, proveedor, puerto y dimensiones)');
  const btn = $('btnCatSync'); if (btn) btn.disabled = true;
  try {
    const r = await fetch(api('/api/pg-sync'), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setCatStatus('Error: ' + (j.error || r.status) + (j.detail ? ' — ' + j.detail : ''), true); return; }
    // Paso 2 (una sola pasada): categoría REAL de ML + velocidad de venta, por SKU.
    setCatStatus(`✓ FOB/dimensiones: ${j.items} filas. Trayendo categoría real y velocidad desde Mercado Libre… (puede tardar ~1 min)`);
    let e = {};
    if (country !== 'co') {
      try { const r2 = await fetch(api('/api/catalog-ml'), { method: 'POST' }); e = await r2.json().catch(() => ({})); if (!r2.ok) e._err = e.error || ('HTTP ' + r2.status); }
      catch (err) { e._err = err.message; }
    }
    // Recargar catálogo enriquecido y fijar la comisión desde la categoría REAL (tabla local).
    _catAll = await catLoad();
    const mapped = applyRealCatCommission(_catAll);
    if (mapped) await catReplace(_catAll);
    _catSig = JSON.stringify(_catAll); paintCatalogo();
    setCatStatus(e._err
      ? `✓ Sincronizado ${j.items} filas (FOB/dims). El paso de categoría real de ML falló (${e._err}); las comisiones quedaron deducidas por título.`
      : `✓ Sincronizado: ${j.items} filas · ${e.enriched || 0} con categoría real de ML · ${e.withVel || 0} con velocidad · comisión fijada por la categoría real en ${mapped} filas. Se conservan precios y arancel/HS.`);
  } catch (e) { setCatStatus('Error de red al sincronizar: ' + e.message, true); }
  finally { if (btn) btn.disabled = false; }
}

// Carga SheetJS (una vez) para leer el .xlsx en el navegador.
let _xlsxP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  if (_xlsxP) return _xlsxP;
  _xlsxP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('no se pudo cargar la librería XLSX'));
    document.head.appendChild(s);
  });
  return _xlsxP;
}
// Convierte a número. Si SheetJS ya entregó un número (ej. 1.5), se usa tal cual.
// Solo si es texto se interpreta formato chileno: '.' miles, ',' decimal ("34.990" → 34990, "1,5" → 1.5).
const _num = v => {
  if (typeof v === 'number') return isNaN(v) ? '' : v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? '' : n;
};
const _pick = (row, names) => { for (const n of names) { for (const k in row) { if (normalize(k) === normalize(n)) return row[k]; } } return ''; };

// Importa el Excel de ProfitGuard (Productos): cruza por SKU y completa
// dimensiones + precios Full/AON; deduce comisión por categoría (local).
async function importCatalogExcel(file) {
  try {
    setCatStatus('Leyendo ' + file.name + '…');
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sh = wb.Sheets['Productos'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sh, { defval: '' });
    if (!rows.length) { setCatStatus('El Excel no tiene filas.', true); return; }

    // Datos del Excel por SKU.
    const bySku = {};
    for (const row of rows) {
      const sku = String(_pick(row, ['SKU'])).trim(); if (!sku) continue;
      bySku[sku] = {
        titulo: String(_pick(row, ['Nombre', 'Título', 'Titulo'])).trim(),
        alto: _num(_pick(row, ['Alto'])), ancho: _num(_pick(row, ['Ancho'])), largo: _num(_pick(row, ['Largo'])), peso: _num(_pick(row, ['Peso'])),
        precioFull: _num(_pick(row, ['Precio full', 'Precio Full'])), precioAON: _num(_pick(row, ['Precio AON', 'Precio aon']))
      };
    }

    // Base: catálogo actual (idealmente ya sincronizado desde PG). Si está vacío,
    // creamos filas a partir del Excel (sin FOB/proveedor — solo para no perder datos).
    let base = _catAll && _catAll.length ? _catAll.slice() : [];
    if (!base.length) base = Object.keys(bySku).map(sku => ({ id: 'xls-' + sku, sku, fob: 0, proveedor: '', puerto: '' }));

    let matched = 0;
    for (const item of base) {
      const e = bySku[item.sku]; if (!e) continue;
      matched++;
      item.titulo = item.titulo || e.titulo;
      item.alto = e.alto; item.ancho = e.ancho; item.largo = e.largo; item.peso = e.peso;
      item.precioFull = e.precioFull; item.precioAON = e.precioAON;
    }

    // Comisión por categoría (deducción local, en chunks para no congelar la UI).
    setCatStatus('Deduciendo categorías y comisiones… 0/' + base.length);
    for (let i = 0; i < base.length; i++) {
      const t = base[i].titulo || '';
      if (t) {
        const mi = deduceCategory(t, ML_CATEGORIES, 'name').index;
        const fi = deduceCategory(t, FBLA_CATEGORIES, 'name').index;
        if (mi >= 0) { base[i].mlCatName = catName('ml', mi); base[i].mlComPct = catCost('ml', mi) || 0; }
        if (fi >= 0) { base[i].fblaCatName = catName('fbla', fi); base[i].fbComPct = catCost('fbla', fi) || 0; }
      }
      if (i % 20 === 0) { setCatStatus('Deduciendo categorías y comisiones… ' + i + '/' + base.length); await new Promise(r => setTimeout(r)); }
    }

    await catReplace(base);
    _catAll = base; _catSig = JSON.stringify(base);
    paintCatalogo();
    setCatStatus(`✓ Excel importado: ${matched} de ${base.length} filas cruzadas por SKU. Comisiones deducidas. DOD queda editable a mano.`);
  } catch (e) { setCatStatus('Error importando el Excel: ' + e.message, true); }
}
function paintCatalogo() {
  const q = normalize(($('catFilter') && $('catFilter').value) || '');
  const filtered = q ? _catAll.filter(x => normalize([x.sku, x.titulo, x.proveedor].join(' ')).includes(q)) : _catAll;
  $('catCount').textContent = (q ? filtered.length + '/' + _catAll.length : _catAll.length) +
    ' ítem' + ((q ? filtered.length : _catAll.length) === 1 ? '' : 's') + (_catBackend ? ' · compartido' : ' · solo local');
  const wrap = $('catDbWrap');
  if (!_catAll.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">El catálogo está vacío. Se carga sincronizando desde ProfitGuard (ver con el equipo).</p>'; return; }
  if (!filtered.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Sin resultados.</p>'; return; }
  const cell = v => (v || v === 0) ? v : '';
  const mc = (key, v) => `<td class="mcell ${key.endsWith('-fa') ? 'fbla-col ' : ''}${v == null ? '' : marginClass(v)}" data-cell="${key}">${v == null ? '–' : fmtPct(v)}</td>`;
  const priceInput = (x, field) => `<td><input type="number" class="cat-price" data-id="${x.id}" data-field="${field}" value="${x[field] || ''}" placeholder="–" min="0" step="1"></td>`;
  const rows = filtered.map(x => { const r = catMargins(x); return `
    <tr data-id="${x.id}" title="Clic para cargar este producto en la Calculadora y simular cambios">
      <td>${escapeHtml(x.sku || '')}</td>
      <td title="${escapeHtml(x.titulo || '')}" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(x.titulo || '')}</td>
      <td>${cell(x.largo)}</td><td>${cell(x.alto)}</td><td>${cell(x.ancho)}</td><td>${cell(x.peso)}</td>
      <td>${x.fob ? ('US$' + x.fob) : ''}</td>
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${escapeHtml(x.puerto || '')}</td>
      <td title="${escapeHtml((x.mlCatPathReal && x.mlCatPathReal.join(' › ')) || '')}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;${x.mlCatNameReal ? '' : 'color:var(--faint)'}">${escapeHtml(x.mlCatNameReal || x.mlCatName || '—')}${x.mlCatNameReal ? '' : ' <span title="Categoría deducida del título, no confirmada en ML. Sincroniza para corregir." style="color:var(--mid)">?</span>'}</td>
      <td class="co-only"><input type="text" class="cat-hs" data-id="${x.id}" value="${escapeHtml(x.hs || '')}" placeholder="–" style="width:88px"></td>
      <td class="co-only"><input type="number" class="cat-ar" data-id="${x.id}" value="${(x.arancelPct || x.arancelPct === 0) ? x.arancelPct : ''}" placeholder="0" min="0" step="0.1" style="width:60px"></td>
      <td class="mcell" data-cell="cogs">${fmtCLP(r.cogs)}</td>
      ${priceInput(x, 'precioFull')}${mc('full-ml', r.full.ml)}${mc('full-fa', r.full.fa)}
      ${priceInput(x, 'precioAON')}${mc('aon-ml', r.aon.ml)}${mc('aon-fa', r.aon.fa)}
      ${priceInput(x, 'precioDOD')}${mc('dod-ml', r.dod.ml)}${mc('dod-fa', r.dod.fa)}
    </tr>`; }).join('');
  wrap.innerHTML = `<table class="histtab dbtab" style="min-width:1700px"><thead><tr>
    <th>SKU</th><th>Título</th><th>Largo</th><th>Alto</th><th>Ancho</th><th>Peso</th><th>Precio FOB</th><th>Proveedor</th><th>Puerto</th><th title="Categoría REAL de Mercado Libre (de la publicación). '?' = deducida del título, sincroniza para corregir.">Categoría ML</th><th class="co-only">HS</th><th class="co-only">Arancel %</th><th>Landed COGS</th>
    <th>Precio Full</th><th>Margen PF Meli</th><th class="fbla-col">Margen PF Fala</th>
    <th>Precio AON</th><th>Margen AON Meli</th><th class="fbla-col">Margen AON Fala</th>
    <th>Precio DOD</th><th>Margen DOD Meli</th><th class="fbla-col">Margen DOD Fala</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll('input.cat-price').forEach(inp => inp.addEventListener('input', () => {
    const item = _catAll.find(x => x.id === inp.dataset.id);
    if (!item) return;
    item[inp.dataset.field] = parseFloat(inp.value) || 0;
    updateCatRow(inp.closest('tr'), item);
    catSaveDebounced(item);
  }));
  // HS (texto) → persiste. Arancel % → recalcula COGS + márgenes en vivo y persiste.
  wrap.querySelectorAll('input.cat-hs').forEach(inp => inp.addEventListener('change', () => {
    const item = _catAll.find(x => x.id === inp.dataset.id); if (!item) return;
    item.hs = inp.value.trim(); catSaveDebounced(item);
  }));
  wrap.querySelectorAll('input.cat-ar').forEach(inp => inp.addEventListener('input', () => {
    const item = _catAll.find(x => x.id === inp.dataset.id); if (!item) return;
    item.arancelPct = inp.value === '' ? '' : (parseFloat(inp.value) || 0);
    updateCatRow(inp.closest('tr'), item);
    catSaveDebounced(item);
  }));
  // Clic en la fila → carga el producto en la Calculadora (sin interferir con la edición de precios/HS/arancel).
  wrap.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('input')) return;
    loadCatalogItem(_catAll.find(x => x.id === tr.dataset.id));
  });
}
function updateCatRow(tr, item) {
  const r = catMargins(item);
  const set = (key, v) => { const td = tr.querySelector(`[data-cell="${key}"]`); if (!td) return; td.textContent = (key === 'cogs') ? fmtCLP(v) : (v == null ? '–' : fmtPct(v)); if (key !== 'cogs') td.className = 'mcell ' + (key.endsWith('-fa') ? 'fbla-col ' : '') + (v == null ? '' : marginClass(v)); };
  set('cogs', r.cogs);
  set('full-ml', r.full.ml); set('full-fa', r.full.fa);
  set('aon-ml', r.aon.ml); set('aon-fa', r.aon.fa);
  set('dod-ml', r.dod.ml); set('dod-fa', r.dod.fa);
}
function exportCatalogoCSV() {
  if (!_catAll.length) { alert('El catálogo está vacío.'); return; }
  const head = ['SKU', 'Título', 'Largo', 'Alto', 'Ancho', 'Peso', 'Precio FOB', 'Proveedor', 'Puerto', 'HS', 'Arancel %', 'Landed COGS',
    'Precio Full', 'Margen PF Meli %', 'Margen PF Fala %', 'Precio AON', 'Margen AON Meli %', 'Margen AON Fala %', 'Precio DOD', 'Margen DOD Meli %', 'Margen DOD Fala %'];
  const q = s => '"' + (s == null ? '' : s).toString().replace(/"/g, '""') + '"';
  const n = v => (v == null || isNaN(v)) ? '' : Math.round(v);
  const p = v => (v == null || isNaN(v)) ? '' : Number(v).toFixed(1).replace('.', ',');
  const lines = [head.join(';')];
  for (const x of _catAll) {
    const r = catMargins(x);
    lines.push([q(x.sku), q(x.titulo), x.largo || '', x.alto || '', x.ancho || '', x.peso || '', x.fob || '', q(x.proveedor), q(x.puerto), q(x.hs), (x.arancelPct || x.arancelPct === 0 ? x.arancelPct : ''), n(r.cogs),
      x.precioFull || '', p(r.full.ml), p(r.full.fa), x.precioAON || '', p(r.aon.ml), p(r.aon.fa), x.precioDOD || '', p(r.dod.ml), p(r.dod.fa)].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'catalogo_margenes.csv'; a.click();
}

/* ---------------- Investigación de categorías (snapshot de Nubimetrics) ---------------- */
const RESEARCH_KEY = 'mpresearch';
let _researchBackend = null, _researchAll = [], _researchSig = '';
let _researchFilters = {};   // {minVentas,minTicket,minCuota,l1,crece:'si'|'no',canib:'si'|'no'}
let _researchSort = { key: 'gmv', dir: -1 };   // orden de la tabla (dir: -1 desc, 1 asc)
// Canibalización: categorías hoja donde ET Brands YA tiene publicaciones. ML ya no
// permite consultas anónimas, así que vamos autenticados por el proxy /api/pg-passthrough
// (token de PG en el servidor): listamos los ítems propios y resolvemos su category_id.
// Cache local 7 días por país. Se recalcula en segundo plano y repinta la tabla.
let _myCats = new Set();
let _p2Index = {};   // { catId: {ts, dif} } — categorías que ya tienen P2 (para columna P2 y opportunity score)
async function loadP2Index() { try { const j = await (await fetch(api('/api/p2?index=1'))).json(); _p2Index = (j && typeof j === 'object') ? j : {}; } catch (e) { _p2Index = {}; } }
async function ptApp(path, query) {
  try { const r = await fetch(api('/api/pg-passthrough'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, query }) }); if (!r.ok) return null; const j = await r.json(); return (j && j.body != null) ? j.body : null; } catch (e) { return null; }
}
async function loadMyCats(force) {
  const site = country === 'co' ? 'MCO' : 'MLC';
  const key = 'mp_mycats_' + site;
  if (!force) { try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.ts && (Date.now() - c.ts < 7 * 864e5) && Array.isArray(c.ids)) { _myCats = new Set(c.ids); return; } } catch (e) {} }
  const me = await ptApp('/users/me', {});
  const sellerId = me && me.id; if (!sellerId) return;   // sin proxy/token: canibalización sólo por flag del import
  // 1) IDs de los ítems propios (páginas de 100, tope de offset 1000).
  const items = [];
  for (let off = 0; off <= 1000; off += 100) {
    const s = await ptApp('/users/' + sellerId + '/items/search', { limit: '100', offset: String(off) });
    const res = (s && s.results) || []; items.push(...res);
    if (!res.length || off + 100 >= ((s && s.paging && s.paging.total) || items.length)) break;
  }
  if (!items.length) return;
  // 2) category_id vía multiget (lotes de 20, de a 6 en paralelo).
  const cats = new Set(), chunks = [];
  for (let i = 0; i < items.length; i += 20) chunks.push(items.slice(i, i + 20));
  for (let i = 0; i < chunks.length; i += 6) {
    const rs = await Promise.all(chunks.slice(i, i + 6).map(ch => ptApp('/items', { ids: ch.join(','), attributes: 'id,category_id' })));
    for (const arr of rs) if (Array.isArray(arr)) for (const e of arr) if (e && e.code === 200 && e.body && e.body.category_id) cats.add(e.body.category_id);
  }
  if (cats.size) { _myCats = cats; try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), ids: [...cats] })); } catch (e) {} }
}
function researchLocalLoad() { try { return JSON.parse(localStorage.getItem(RESEARCH_KEY) || '[]'); } catch (e) { return []; } }
function researchLocalSave(h) { localStorage.setItem(RESEARCH_KEY, JSON.stringify(h)); }
async function researchLoad() {
  if (_researchBackend !== false) {
    try { const r = await fetch(api('/api/research')); if (r.ok) { _researchBackend = true; return await r.json(); } _researchBackend = false; } catch (e) { _researchBackend = false; }
  }
  return researchLocalLoad();
}
async function researchReplace(items) {
  if (_researchBackend !== false) {
    try { const r = await fetch(api('/api/research'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items) }); if (r.ok) { _researchBackend = true; return true; } _researchBackend = false; } catch (e) { _researchBackend = false; }
  }
  researchLocalSave(items); return false;
}
function setResearchStatus(msg, isErr) { const el = $('researchStatus'); if (!el) return; el.textContent = msg || ''; el.style.color = isErr ? 'var(--bad)' : 'var(--muted)'; }
// Cuota de venta por seller = ventas (GMV) / competidores profesionales.
function researchCuota(x) { const v = parseFloat(x.ventasGmv) || 0, c = parseFloat(x.competidores) || 0; return c > 0 ? v / c : null; }
// Crecimiento interanual CANÓNICO (usado en TODA la app para que coincida): suma de los
// últimos 12 meses vs los 12 meses previos. Robusto ante estacionalidad (necesita ≥24 meses).
function yoy12m(serie, field) {
  const s = Array.isArray(serie) ? serie : [];
  if (s.length < 24) return null;
  const g = s.map(p => parseFloat(p[field || 'gmv']) || 0);
  const last = g.slice(-12).reduce((a, b) => a + b, 0), prev = g.slice(-24, -12).reduce((a, b) => a + b, 0);
  return prev > 0 ? (last - prev) / prev * 100 : null;
}
function yoy12(serie) { return yoy12m(serie, 'gmv'); }
// (Legacy) YoY del GMV acumulado del año (YTD). Se mantiene por compatibilidad; la app usa yoy12.
function researchYtdYoY(x) {
  const s = Array.isArray(x.serie) ? x.serie : [];
  if (s.length < 13) return null;
  const last = s[s.length - 1].m.slice(0, 7).split('-').map(Number);   // [año, mes] del último dato
  const curYear = last[0], curMonth = last[1];
  const sumYtd = year => {
    let t = 0, any = false;
    for (const p of s) { const [py, pm] = p.m.slice(0, 7).split('-').map(Number); if (py === year && pm <= curMonth) { const v = parseFloat(p.gmv); if (!isNaN(v)) { t += v; any = true; } } }
    return any ? t : null;
  };
  const cur = sumYtd(curYear), prev = sumYtd(curYear - 1);
  return (cur != null && prev != null && prev > 0) ? (cur - prev) / prev * 100 : null;
}
async function renderResearch() { _researchAll = await researchLoad(); _researchSig = JSON.stringify(_researchAll); paintResearch(); p2BatchUI(); loadMyCats().then(() => paintResearch()).catch(() => {}); loadP2Index().then(paintResearch).catch(() => {}); }

// --- Filtro avanzado de la tabla de investigación ---
function researchFiltersActive() { const f = _researchFilters || {}; return !!(f.minVentas != null || f.minTicket != null || f.minCuota != null || f.l1 || f.crece || f.canib); }
function researchPassesFilter(x) {
  const f = _researchFilters || {};
  if (f.minVentas != null && (parseFloat(x.ventasGmv) || 0) < f.minVentas) return false;
  if (f.minTicket != null && (parseFloat(x.ticket) || 0) < f.minTicket) return false;
  if (f.minCuota != null && (researchCuota(x) || 0) < f.minCuota) return false;
  if (f.l1 && normalize(x.l1 || '') !== normalize(f.l1)) return false;
  if (f.crece) { const y = yoy12(x.serie); if (f.crece === 'si' && !(y != null && y > 0)) return false; if (f.crece === 'no' && !(y != null && y <= 0)) return false; }
  if (f.canib) { const c = !!(x.canibalizacion || _myCats.has(x.id)); if (f.canib === 'si' && !c) return false; if (f.canib === 'no' && c) return false; }
  return true;
}
function openResearchFilter() {
  // Poblar el desplegable de L1 con las L1 presentes (con ventas).
  const l1s = [...new Set(_researchAll.filter(x => (parseFloat(x.ventasGmv) || 0) > 0).map(x => x.l1).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const sel = $('rfL1'); if (sel) sel.innerHTML = '<option value="">Todas</option>' + l1s.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
  const f = _researchFilters || {};
  $('rfMinVentas').value = f.minVentas != null ? f.minVentas : '';
  $('rfMinTicket').value = f.minTicket != null ? f.minTicket : '';
  $('rfMinCuota').value = f.minCuota != null ? f.minCuota : '';
  if (sel) sel.value = f.l1 || '';
  $('rfCrece').value = f.crece || '';
  $('rfCanib').value = f.canib || '';
  $('researchFilterOverlay').classList.remove('hidden');
}
function applyResearchFilter() {
  const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
  _researchFilters = {
    minVentas: num('rfMinVentas'), minTicket: num('rfMinTicket'), minCuota: num('rfMinCuota'),
    l1: $('rfL1').value || '', crece: $('rfCrece').value || '', canib: $('rfCanib').value || ''
  };
  $('researchFilterOverlay').classList.add('hidden');
  paintResearch();
}
function clearResearchFilter() {
  _researchFilters = {};
  ['rfMinVentas', 'rfMinTicket', 'rfMinCuota'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  ['rfL1', 'rfCrece', 'rfCanib'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('researchFilterOverlay').classList.add('hidden');
  paintResearch();
}
// --- Opportunity Score (0-100, relativo entre categorías con P2) ---
const OPP_W = { dif: 0.30, fit: 0.25, size: 0.17, comp: 0.13, growth: 0.10, ticket: 0.03, seas: 0.02 };
function pctRank(sortedAsc, v) { const n = sortedAsc.length; if (!n) return 50; let c = 0; for (let i = 0; i < n; i++) { if (sortedAsc[i] <= v) c++; else break; } return c / n * 100; }
function seasonEvenness(serie) {   // menos variabilidad estacional = más parejo = mejor
  const s = p2Seasonality(Array.isArray(serie) ? serie : []); const v = s.map(p => p.idx).filter(x => !isNaN(x)); if (!v.length) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length; return -Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}
// Referencia de percentiles: TODAS las categorías con P2 (score estable, no depende del filtro).
function oppRef() {
  const ref = _researchAll.filter(x => _p2Index[x.id]);
  return {
    gmv: ref.map(x => parseFloat(x.ventasGmv) || 0).sort((a, b) => a - b),
    comp: ref.map(x => -(parseFloat(x.competidores) || 0)).sort((a, b) => a - b),
    yoy: ref.map(x => yoy12(x.serie)).filter(v => v != null).sort((a, b) => a - b),
    ticket: ref.map(x => parseFloat(x.ticket) || 0).sort((a, b) => a - b),
    seas: ref.map(x => seasonEvenness(x.serie)).sort((a, b) => a - b)
  };
}
function oppBreakdown(x, ref) {
  const idx = _p2Index[x.id]; if (!idx) return null;
  const y = yoy12(x.serie);
  const parts = [
    { name: 'Diferenciabilidad (IA)', w: OPP_W.dif, score: idx.dif != null ? idx.dif : 50, real: idx.dif != null },
    { name: 'Fit de producto (IA)', w: OPP_W.fit, score: idx.fit != null ? idx.fit : 50, real: idx.fit != null },
    { name: 'Tamaño (GMV)', w: OPP_W.size, score: pctRank(ref.gmv, parseFloat(x.ventasGmv) || 0), real: true },
    { name: 'Competencia (nº vendedores)', w: OPP_W.comp, score: pctRank(ref.comp, -(parseFloat(x.competidores) || 0)), real: true },
    { name: 'Crecimiento (YoY 12m)', w: OPP_W.growth, score: y == null ? 50 : pctRank(ref.yoy, y), real: y != null },
    { name: 'Ticket medio', w: OPP_W.ticket, score: pctRank(ref.ticket, parseFloat(x.ticket) || 0), real: true },
    { name: 'Estacionalidad (regularidad)', w: OPP_W.seas, score: pctRank(ref.seas, seasonEvenness(x.serie)), real: true }
  ];
  const bonus = (idx.conc != null) ? (idx.conc < 0.25 ? 5 : (idx.conc > 0.5 ? -5 : 0)) : 0;   // concentración (ranking profundo)
  const raw = parts.reduce((a, p) => a + p.w * p.score, 0) + bonus;
  return { total: Math.max(0, Math.min(100, Math.round(raw))), parts, bonus };
}
function oppScore(x, ref) { const b = oppBreakdown(x, ref); return b ? b.total : null; }
// Popup con el desglose del score (nombre, peso, puntaje y aporte de cada componente).
function openOppBreakdown(item) {
  const b = oppBreakdown(item, oppRef()); if (!b) return;
  $('oppTitle').textContent = (item.leaf || '') + ' — ' + b.total + '/100';
  const rows = b.parts.map(p => `<tr><td>${escapeHtml(p.name)}${p.real ? '' : ' <span class="muted" title="La IA aún no calculó este puntaje (P2 antiguo); se usa 50 neutro. Re-analiza para el valor real.">· neutro</span>'}</td><td style="text-align:right">${Math.round(p.w * 100)}%</td><td style="text-align:right">${Math.round(p.score)}</td><td style="text-align:right;font-weight:700">${(p.w * p.score).toFixed(1)}</td></tr>`).join('');
  const bonusRow = b.bonus ? `<tr><td>Bonus concentración</td><td></td><td></td><td style="text-align:right;font-weight:700;color:${b.bonus > 0 ? 'var(--good)' : 'var(--bad)'}">${b.bonus > 0 ? '+' : ''}${b.bonus}</td></tr>` : '';
  $('oppBody').innerHTML = `<p class="hint" style="margin:0 0 8px">Puntaje relativo entre las categorías con P2. Cada componente se normaliza 0-100 (percentil dentro del set con P2) y se pondera por su peso.</p>` +
    `<div style="overflow:auto"><table class="p2own" style="width:100%"><thead><tr><th style="text-align:left">Componente</th><th style="text-align:right">Peso</th><th style="text-align:right">Puntaje</th><th style="text-align:right">Aporte</th></tr></thead><tbody>${rows}${bonusRow}<tr style="border-top:2px solid var(--line)"><td style="font-weight:800">Opportunity Score</td><td></td><td></td><td style="text-align:right;font-weight:800;color:var(--accent)">${b.total}</td></tr></tbody></table></div>`;
  $('oppOverlay').classList.remove('hidden');
}
function paintResearch() {
  const q = normalize(($('researchFilter') && $('researchFilter').value) || '');
  const conVentas = _researchAll.filter(x => (parseFloat(x.ventasGmv) || 0) > 0);   // omite categorías con 0 ventas
  const afFilter = researchFiltersActive() ? conVentas.filter(researchPassesFilter) : conVentas;
  const filtered = q ? afFilter.filter(x => normalize([x.l1, x.leaf].join(' ')).includes(q)) : afFilter;
  const narrowed = q || researchFiltersActive();
  { const c = $('btnResearchClear'); if (c) c.classList.toggle('hidden', !researchFiltersActive()); }
  $('researchCount').textContent = (narrowed ? filtered.length + '/' + conVentas.length : conVentas.length) +
    ' categoría' + ((narrowed ? filtered.length : conVentas.length) === 1 ? '' : 's') + ' con ventas' +
    (researchFiltersActive() ? ' · filtrado' : '') + (_researchBackend ? ' · compartido' : ' · solo local');
  const wrap = $('researchDbWrap');
  if (!_researchAll.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Aún no hay datos. Recolecta desde Nubimetrics (script recolector) y usa “Importar datos”.</p>'; return; }
  if (!conVentas.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Ninguna categoría con ventas > 0.</p>'; return; }
  if (!filtered.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Sin resultados.</p>'; return; }
  const intfmt = v => (v != null && v !== '' && !isNaN(v)) ? Math.round(v).toLocaleString('es-CL') : '–';
  // ordenar por cuota x seller descendente (categoría más atractiva primero)
  const yoyCell = x => { const y = yoy12(x.serie); if (y == null) return '<td class="mcell muted">–</td>'; const col = y >= 0 ? 'var(--good)' : 'var(--bad)'; return `<td class="mcell" style="color:${col};font-weight:600">${y >= 0 ? '+' : ''}${y.toFixed(1)}%</td>`; };
  const canibCell = x => (x.canibalizacion || _myCats.has(x.id)) ? '<td style="text-align:center"><span style="color:var(--accent);font-weight:700" title="Ya tenemos productos publicados en esta categoría">● Sí</span></td>' : '<td style="text-align:center" class="muted">–</td>';
  const p2Cell = x => _p2Index[x.id] ? '<td style="text-align:center"><span style="color:var(--good);font-weight:700" title="Ya tiene análisis P2 guardado">Sí</span></td>' : '<td style="text-align:center" class="muted">No</td>';
  const ref = oppRef();
  const oppCell = x => { const s = oppScore(x, ref); if (s == null) return '<td style="text-align:center" class="muted" title="Sin P2: corre el análisis para obtener el score">–</td>'; const col = s >= 66 ? 'var(--good)' : s >= 40 ? 'var(--mid)' : 'var(--bad)'; return `<td style="text-align:center;font-weight:800;color:${col}" title="Opportunity Score 0-100">${s}</td>`; };
  const sortVal = x => { switch (_researchSort.key) { case 'opp': { const s = oppScore(x, ref); return s == null ? -1 : s; } case 'yoy': { const y = yoy12(x.serie); return y == null ? -1e9 : y; } case 'ticket': return parseFloat(x.ticket) || 0; case 'comp': return parseFloat(x.competidores) || 0; case 'cuota': return researchCuota(x) || 0; default: return parseFloat(x.ventasGmv) || 0; } };
  const rows = filtered.slice().sort((a, b) => _researchSort.dir * (sortVal(a) - sortVal(b))).map(x => {
    const cuota = researchCuota(x);
    return `<tr data-id="${escapeHtml(x.id || '')}">
      <td>${escapeHtml(x.l1 || '')}</td>
      <td>${escapeHtml(x.leaf || '')}</td>
      ${oppCell(x)}
      ${p2Cell(x)}
      ${canibCell(x)}
      <td class="mcell">${fmtCLP(x.ventasGmv)}</td>
      ${yoyCell(x)}
      <td class="mcell">${fmtCLP(x.ticket)}</td>
      <td class="mcell">${intfmt(x.competidores)}</td>
      <td class="mcell">${cuota != null ? fmtCLP(cuota) : '–'}</td>
    </tr>`; }).join('');
  const arrow = k => _researchSort.key === k ? `<span style="color:var(--accent)">${_researchSort.dir === -1 ? ' ▼' : ' ▲'}</span>` : ' <span style="opacity:.35;font-size:10px">⇅</span>';
  wrap.innerHTML = `<table class="histtab dbtab restab-compact" style="min-width:1020px"><thead><tr>
    <th>Categoría L1</th><th>Categoría hoja</th><th data-sort="opp" style="cursor:pointer" title="Opportunity Score 0-100 (solo con P2): diferenciabilidad IA 35% + tamaño + competencia (menos vendedores) + crecimiento + ticket + estacionalidad. Clic para ordenar.">Opportunity${arrow('opp')}</th><th title="Categorías con análisis P2 guardado">P2</th><th title="Categorías donde ET Brands ya tiene productos publicados">Canibalización</th><th data-sort="gmv" style="cursor:pointer">Ventas prom (GMV, 12m)${arrow('gmv')}</th><th data-sort="yoy" style="cursor:pointer" title="Crecimiento del GMV: últimos 12 meses vs los 12 previos. Clic para ordenar.">Crec. YoY (12m)${arrow('yoy')}</th><th data-sort="ticket" style="cursor:pointer">Ticket medio (12m)${arrow('ticket')}</th><th data-sort="comp" style="cursor:pointer" title="Cantidad de vendedores profesionales (12m). Clic para ordenar.">Vendedores${arrow('comp')}</th><th data-sort="cuota" style="cursor:pointer">Cuota x seller${arrow('cuota')}</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll('th[data-sort]').forEach(th => { th.onclick = () => { const k = th.dataset.sort; if (_researchSort.key === k) _researchSort.dir *= -1; else { _researchSort.key = k; _researchSort.dir = -1; } paintResearch(); }; });
  wrap.querySelectorAll('tbody tr[data-id]').forEach(tr => { tr.title = 'Clic para ver el reporte de la categoría'; tr.onclick = () => openResearchDetail(_researchAll.find(x => x.id === tr.dataset.id)); });
}

/* ---------------- Reporte de detalle de categoría ---------------- */
let _rdItem = null, _rdMetric = 'gmv';
function openResearchDetail(item) {
  if (!item) return;
  _rdItem = item; _rdMetric = 'gmv';
  $('rdL1').textContent = item.l1 || '';
  $('rdLeaf').textContent = item.leaf || '';
  // Deep-link a "Rankings de mercado". La página SÍ preselecciona la hoja al cargar si se le pasa
  // el PATH COMPLETO con guiones (no el id suelto) en category=, y un día en range=YYYY-MM-DD.
  // (Ranking = pestaña "Publicaciones"; "Lo más buscado" = pestaña "Demanda" de la misma vista.)
  const catPath = item.path || item.id || '';
  const rDay = new Date().toISOString().slice(0, 10);
  const rankUrl = 'https://app.nubimetrics.com/market/sellerranking#?category=' + catPath + '&range=' + rDay;
  $('rdRanking').href = rankUrl;
  $('rdTrends').href = rankUrl;
  document.querySelectorAll('.rd-mbtn').forEach(b => b.classList.toggle('active', b.dataset.metric === 'gmv'));
  populateRdRange(item);
  renderRdChart();
  { const pp = $('p2Panel'); if (pp) { pp.classList.add('hidden'); pp.innerHTML = ''; } const b = $('p2Btn'); if (b) b.style.display = ''; }
  // Botón del Opportunity Score (si la categoría tiene P2) → abre el desglose.
  { const ob = $('rdOppBtn'); if (ob) { const s = oppScore(item, oppRef()); if (s != null) { ob.textContent = '🎯 Opportunity ' + s; ob.classList.remove('hidden'); ob.onclick = () => openOppBreakdown(item); } else ob.classList.add('hidden'); } }
  _p2ChatOpen = false; _p2DeepOpen = false; _p2Busy = false;   // reset UI interactiva P2 al cambiar de categoría
  $('rDetailOverlay').classList.remove('hidden');
  p2LoadCached(item);   // si ya hay análisis guardado, se muestra solo (sin re-analizar)
}
const RD_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function rdMonthLabel(ym) { const [y, m] = String(ym || '').split('-'); const i = parseInt(m, 10) - 1; return (RD_MESES[i] || m || '') + ' ' + (y || ''); }
// Puebla los selectores Desde/Hasta con los meses disponibles de la serie (rango completo por defecto).
function populateRdRange(item) {
  const months = (Array.isArray(item.serie) ? item.serie : []).map(p => (p.m || '').slice(0, 7)).filter(Boolean);
  const opts = months.map(ym => `<option value="${ym}">${rdMonthLabel(ym)}</option>`).join('');
  const from = $('rdFrom'), to = $('rdTo');
  from.innerHTML = opts; to.innerHTML = opts;
  if (months.length) { from.value = months[0]; to.value = months[months.length - 1]; }
}
function renderRdChart() {
  const item = _rdItem; if (!item) return;
  const serie = Array.isArray(item.serie) ? item.serie : [];
  const metric = _rdMetric;
  let fromV = ($('rdFrom') && $('rdFrom').value) || '', toV = ($('rdTo') && $('rdTo').value) || '';
  if (fromV && toV && fromV > toV) { const t = fromV; fromV = toV; toV = t; }   // por si eligen invertido
  const sub = serie.filter(p => { const ym = (p.m || '').slice(0, 7); return (!fromV || ym >= fromV) && (!toV || ym <= toV); });
  const points = sub.map(p => ({ m: (p.m || '').slice(0, 7), v: parseFloat(p[metric]) || 0 }));
  if (!points.length) {
    $('rdChart').innerHTML = '<p class="muted" style="padding:24px;text-align:center;line-height:1.6">Aún no hay serie mensual para este rango.<br>Corre el recolector con <b>run({months:36})</b> y re-importa para ver la evolución.</p>';
    $('rdYoy').textContent = '';
    return;
  }
  // YoY canónico: últimos 12 meses vs los 12 previos (misma métrica que la tabla y el P2).
  const yoy = yoy12m(serie, metric);
  $('rdYoy').innerHTML = yoy != null
    ? 'Crecimiento interanual (12m): <b style="color:' + (yoy >= 0 ? 'var(--good)' : 'var(--bad)') + '">' + (yoy >= 0 ? '+' : '') + yoy.toFixed(1) + '%</b>'
    : '<span class="muted">YoY: faltan 24 meses de datos</span>';
  $('rdChart').innerHTML = rdChartSVG(points, metric);
  wireRdChartHover();
}
let _rdGeo = null;
function rdChartSVG(points, metric) {
  const W = 720, H = 240, padL = 64, padR = 16, padT = 16, padB = 34;
  const vals = points.map(p => p.v), max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const iw = W - padL - padR, ih = H - padT - padB;
  const X = i => padL + (points.length <= 1 ? iw / 2 : i * iw / (points.length - 1));
  const Y = v => padT + ih - (max - min ? (v - min) / (max - min) : 0) * ih;
  const xs = points.map((p, i) => X(i)), ys = points.map(p => Y(p.v));
  const line = points.map((p, i) => (i ? 'L' : 'M') + xs[i].toFixed(1) + ',' + ys[i].toFixed(1)).join(' ');
  const area = 'M' + xs[0].toFixed(1) + ',' + (padT + ih) + ' ' + points.map((p, i) => 'L' + xs[i].toFixed(1) + ',' + ys[i].toFixed(1)).join(' ') + ' L' + xs[points.length - 1].toFixed(1) + ',' + (padT + ih) + ' Z';
  const fmtFull = v => metric === 'prof' ? Math.round(v).toLocaleString('es-CL') : ('$' + Math.round(v).toLocaleString('es-CL'));
  const fmtAxis = v => metric === 'prof' ? Math.round(v) : (v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'b' : v >= 1e6 ? '$' + Math.round(v / 1e6) + 'M' : '$' + Math.round(v / 1e3) + 'k');
  const yTicks = [max, (max + min) / 2, min].map(v => `<line x1="${padL}" y1="${Y(v).toFixed(1)}" x2="${W - padR}" y2="${Y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 8}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtAxis(v)}</text>`).join('');
  const idxs = [...new Set([0, Math.floor(points.length / 2), points.length - 1])];
  const xLabels = idxs.map(i => `<text x="${xs[i].toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--muted)">${points[i].m}</text>`).join('');
  const dots = points.map((p, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.6" fill="var(--accent)"/>`).join('');
  const guide = `<line class="rd-guide" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`;
  const active = `<circle class="rd-active" r="5" fill="var(--accent)" stroke="#121215" stroke-width="2" style="display:none"/>`;
  const metricName = metric === 'gmv' ? 'Ventas en $' : metric === 'prof' ? 'Vendedores' : 'Ticket medio';
  _rdGeo = { xs, ys, vals, labels: points.map(p => rdMonthLabel(p.m)), W, H, fmt: fmtFull, metricName };
  const tip = `<div class="rd-tip"><div class="tm"></div><div class="tv"><span class="dot"></span><span class="tl"></span> : <b></b></div></div>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:720px;display:block">${yTicks}<path d="${area}" fill="rgba(255,102,0,.14)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${guide}${dots}${active}${xLabels}</svg>${tip}`;
}
// Tooltip branded que sigue el cursor: mes en grande ("Marzo 2026") + métrica del eje Y.
function wireRdChartHover() {
  const host = $('rdChart'); const svg = host && host.querySelector('svg'); if (!svg || !_rdGeo) return;
  const tip = host.querySelector('.rd-tip'), guide = svg.querySelector('.rd-guide'), active = svg.querySelector('.rd-active'), g = _rdGeo;
  function show(idx) {
    const rect = svg.getBoundingClientRect(), hostRect = host.getBoundingClientRect();
    const sx = rect.width / g.W, sy = rect.height / g.H;
    guide.setAttribute('x1', g.xs[idx]); guide.setAttribute('x2', g.xs[idx]); guide.style.display = '';
    active.setAttribute('cx', g.xs[idx]); active.setAttribute('cy', g.ys[idx]); active.style.display = '';
    tip.querySelector('.tm').textContent = g.labels[idx];
    tip.querySelector('.tl').textContent = g.metricName;
    tip.querySelector('.tv b').textContent = g.fmt(g.vals[idx]);
    const px = (rect.left - hostRect.left) + g.xs[idx] * sx, py = (rect.top - hostRect.top) + g.ys[idx] * sy;
    const half = (tip.offsetWidth / 2) || 60;
    tip.style.left = Math.max(half + 2, Math.min(hostRect.width - half - 2, px)) + 'px';
    tip.style.top = py + 'px'; tip.classList.add('on');
  }
  function hide() { tip.classList.remove('on'); guide.style.display = 'none'; active.style.display = 'none'; }
  svg.addEventListener('mousemove', e => {
    const rect = svg.getBoundingClientRect(), sx = rect.width / g.W, mx = (e.clientX - rect.left) / sx;
    let best = 0, bd = Infinity; for (let i = 0; i < g.xs.length; i++) { const d = Math.abs(g.xs[i] - mx); if (d < bd) { bd = d; best = i; } }
    show(best);
  });
  svg.addEventListener('mouseleave', hide);
}
/* ============================================================
   P2 — Análisis de una categoría hoja (botón "Hacer análisis").
   Combina: (a) datos que ya tenemos (serie 36m → estacionalidad/cuota/tendencia),
   (b) Mercado Libre vía ProfitGuard (/api/ml → best-sellers + fichas + reseñas),
   (c) Claude (/api/anthropic) para clusters y diferenciación. Cachea en KV.
   ============================================================ */
let _p2Running = false;
// Rate-limiter global de ML (vía ProfitGuard, límite 120/min por key). Token bucket:
// permite ráfagas cortas (P2 on-demand sale rápido) pero limita el sostenido a ~100/min
// (clave para el batch de 500). Todas las llamadas mlGet pasan por acá.
let _mlTokens = 100, _mlLast = 0;
const ML_MAX = 100, ML_RATE = 100 / 60000;   // tokens/ms ≈ 100/min
async function mlGate() {
  for (;;) {
    const now = Date.now();
    if (!_mlLast) _mlLast = now;
    _mlTokens = Math.min(ML_MAX, _mlTokens + (now - _mlLast) * ML_RATE);
    _mlLast = now;
    if (_mlTokens >= 1) { _mlTokens -= 1; return; }
    await new Promise(r => setTimeout(r, 250));
  }
}
async function mlGet(path, query) {
  await mlGate();
  const r = await fetch(api('/api/ml'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, query: query || {} }) });
  const j = await r.json().catch(() => ({ error: 'respuesta no-JSON' }));
  if (!r.ok || j.error) throw new Error(j.error || ('ml ' + r.status));
  return j.body;
}
async function p2MapLimit(items, limit, fn) { const out = []; let i = 0; async function w() { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; } } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); return out; }

const P2_MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function p2Seasonality(serie) {
  const by = {}; for (const p of serie) { const m = parseInt((p.m || '').slice(5, 7), 10); const v = parseFloat(p.gmv); if (m >= 1 && !isNaN(v)) (by[m] = by[m] || []).push(v); }
  const avgAll = (() => { const a = serie.map(p => parseFloat(p.gmv)).filter(v => !isNaN(v)); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; })();
  const idx = []; for (let m = 1; m <= 12; m++) { const a = by[m] || []; const av = a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; idx.push({ m, mo: P2_MESES[m - 1], idx: avgAll ? Math.round(av / avgAll * 100) : 0 }); }
  return idx;
}
function p2Trend(serie) {
  const yoy = yoy12(serie);   // misma métrica canónica que la tabla y el gráfico
  return { yoy, dir: yoy == null ? 'sin datos' : (yoy > 8 ? 'EN ALZA' : yoy < -8 ? 'A LA BAJA' : 'ESTABLE') };
}
function p2CuotaClass(item) {
  const cuota = researchCuota(item); if (cuota == null) return { cuota: null, clase: '—' };
  const arr = _researchAll.map(x => researchCuota(x)).filter(v => v != null).sort((a, b) => a - b);
  const p = arr.length ? arr.filter(v => v <= cuota).length / arr.length * 100 : 0;
  return { cuota, pct: Math.round(p), clase: p >= 90 ? 'ALTA' : p >= 50 ? 'MEDIA' : 'BAJA' };
}
function p2Attr(body, id) { const a = (body.attributes || []).find(x => x.id === id); return a ? (a.value_name || '') : ''; }
function p2Pics(body, n) {
  return (body.pictures || []).map(p => p.secure_url || p.url).filter(Boolean).slice(0, n || 2);
}
function p2Prod(pos, id, body) {
  const attrs = (body.attributes || []).filter(a => a.value_name && !/^\d+ (cm|kg|px)/.test(a.value_name)).slice(0, 12).map(a => a.name + ': ' + a.value_name).join(' · ').slice(0, 220);
  return { pos, id, name: (body.name || '').slice(0, 90), brand: p2Attr(body, 'BRAND'), attrs, pics: p2Pics(body, 2), pdp: 'https://www.mercadolibre.cl/p/' + id };
}

function p2RankUrl(item) {
  const catPath = item.path || item.id || '';
  const rDay = new Date().toISOString().slice(0, 10);
  return 'https://app.nubimetrics.com/market/sellerranking#?category=' + catPath + '&range=' + rDay;
}
async function p2CacheGet(id) { try { return await (await fetch(api('/api/p2?id=' + encodeURIComponent(id)))).json(); } catch (e) { return null; } }
async function p2CachePut(id, report) { return fetch(api('/api/p2'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, report }) }); }
// Núcleo de P2 SIN UI: junta stats + ML + IA y devuelve el reporte (no cachea ni renderiza).
// Lo usan tanto runP2 (on-demand, con render) como el batch (masivo, sin render).
async function computeP2Report(item, onProgress) {
  const log = onProgress || (() => {});
  const serie = Array.isArray(item.serie) ? item.serie : [];
  const stats = { seasonality: p2Seasonality(serie), trend: p2Trend(serie), cuota: p2CuotaClass(item), ticket: item.ticket, ventasGmv: item.ventasGmv, competidores: item.competidores };
  log('Trayendo los productos más vendidos de Mercado Libre…');
  const hl = await mlGet('/highlights/MLC/category/' + item.id).catch(() => null);
  let products = [], reviews = null;
  const content = (hl && hl.content) || [];
  const catProds = content.filter(c => c.type === 'PRODUCT').slice(0, 20);
  if (catProds.length) {
    log('Leyendo fichas técnicas de ' + catProds.length + ' productos…');
    const dets = await p2MapLimit(catProds, 5, async c => { const b = await mlGet('/products/' + c.id); return p2Prod(c.position, c.id, b); });
    products = dets.filter(Boolean);
    log('Trayendo reseñas de los más vendidos…');
    const revs = await p2MapLimit(products.slice(0, 3), 3, async p => {
      try {
        const its = await mlGet('/products/' + p.id + '/items');
        const win = ((its && its.results) || [])[0]; if (!win) return null;
        const rv = await mlGet('/reviews/item/' + win.item_id);
        const samples = ((rv && rv.reviews) || []).slice(0, 4).map(x => ({ rate: x.rate, title: x.title, content: (x.content || '').slice(0, 180) }));
        return { name: p.name, pos: p.pos, price: win.price, avg: rv && rv.rating_average, total: rv && (rv.paging && rv.paging.total), levels: rv && rv.rating_levels, samples };
      } catch (e) { return null; }
    });
    reviews = revs.filter(Boolean);
  }
  log('Buscando tu catálogo propio en ProfitGuard…');
  const own = await p2OwnGet(item);
  // Enriquecer TUS productos con 2 fotos + ficha real de su publicación ML (para el análisis con visión).
  if (own && own.products && own.products.length) {
    log('Trayendo fotos y fichas de tus productos…');
    await p2MapLimit(own.products.filter(p => p.mlItemId).slice(0, 8), 4, async p => {
      try {
        const b = await mlGet('/items/' + p.mlItemId, { include_attributes: 'all' });
        p.pics = p2Pics(b, 2);
        p.attrs = (b.attributes || []).filter(a => a.value_name && a.id !== 'SELLER_SKU' && a.id !== 'GTIN').slice(0, 14).map(a => a.name + ': ' + a.value_name).join(' · ').slice(0, 240);
      } catch (e) {}
    });
  }
  log('La IA está analizando fotos, fichas y reseñas de cada producto…');
  // Análisis con VISIÓN (fotos de top + propios). Si falla, cae al análisis de solo texto.
  let ai = await p2VisionAI(item, stats, products, reviews, own).catch(e => ({ _err: String(e.message || e) }));
  if (ai && ai._err) ai = await p2AI(item, stats, products, reviews, own).catch(e => ({ _err: String(e.message || e) }));
  return { v: 1, cat: { l1: item.l1, leaf: item.leaf, id: item.id, path: item.path }, stats, products, reviews, own, ai, rankUrl: p2RankUrl(item) };
}
// Deriva un término de búsqueda del nombre de la hoja (singular) y trae el catálogo propio de PG.
function p2OwnQuery(leaf) { const w = (leaf || '').trim().split(/\s+/)[0]; if (w.length < 3) return ''; return w.endsWith('es') ? w.slice(0, -2) : (w.endsWith('s') ? w.slice(0, -1) : w); }
// El catálogo propio del P2 se lee LOCAL (del Catálogo ya enriquecido con la
// categoría real de ML + velocidad + margen de contribución). No consulta nada.
async function p2OwnGet(item) {
  const cat = item && item.id; if (!cat) return null;
  try {
    if (!_catAll || !_catAll.length) { try { _catAll = await catLoad(); } catch (e) {} }
    const rows = (_catAll || []).filter(x => x.mlCatId && x.mlCatId === cat);
    if (!rows.length) return { ok: true, cat, brand: '', products: [], n: 0, local: true };
    const bySku = new Map();   // una fila por sourcing puede repetir SKU → dedup
    for (const x of rows) { const k = x.sku || x.id; if (!bySku.has(k)) bySku.set(k, x); }
    const products = [...bySku.values()].map(x => {
      const m = catMargins(x);
      // Precio efectivo: el AON del catálogo si está, si no el precio real de ML.
      const effPrice = x.precioAON ? +x.precioAON : (x.mlPrice ? +x.mlPrice : 0);
      let margin = null;
      if (effPrice > 0) {   // margen de CONTRIBUCIÓN al precio efectivo (no null solo porque falte el AON)
        const weight = billableWeight(x.peso || 0, x.alto || 0, x.ancho || 0, x.largo || 0, VOL_DIVISOR);
        margin = Math.round(computeChannel('ml', effPrice, m.cogs, x.mlComPct || 0, weight, !!x.isSuper, cfg).marginPct);
      }
      return {
        name: x.titulo || x.sku, sku: x.sku || '', brand: ownBrandOf(x.titulo), active: x.active !== false,
        cost: Math.round(m.cogs || 0), fob: x.fob || null, abc: x.abc || null, comPct: x.mlComPct || 0,
        vel: x.vel != null ? x.vel : null, velWeeks: x.velWeeks || 0, stock: x.stock != null ? x.stock : null,
        price: effPrice ? Math.round(effPrice) : null, margin, mlItemId: x.mlItemId || null
      };
    }).sort((a, b) => (b.active - a.active) || ((b.vel || 0) - (a.vel || 0)));
    const bc = {}; for (const p of products) if (p.active && p.brand) bc[p.brand] = (bc[p.brand] || 0) + 1;
    const brand = Object.keys(bc).sort((a, b) => bc[b] - bc[a])[0] || '';
    return { ok: true, cat, brand, products, n: products.length, local: true };
  } catch (e) { return null; }
}
function p2OwnTxt(own) {
  if (!own || !own.products || !own.products.length) return '';
  return own.products.slice(0, 14).map(p => `- ${p.name} [${p.brand || 's/marca'}]${p.active ? '' : ' (inactivo)'}`
    + (p.abc ? ` · clase ${p.abc}` : '')
    + (p.vel != null ? ` · vende ${p.vel} u/sem (real, semanas con stock)` : '')
    + ` · COGS $${(p.cost || 0).toLocaleString('es-CL')}`
    + (p.fob != null ? ` · FOB US$${p.fob}` : '')
    + (p.price ? ` · precio AON $${p.price.toLocaleString('es-CL')}` : '')
    + (p.margin != null ? ` · margen contrib ${p.margin}%` : '')
    + (p.stock != null ? ` · stock ${p.stock}` : '')).join('\n');
}
// Convierte **negrita** de la IA a <strong> y limpia asteriscos sueltos, escapando el resto.
function mdBold(t) {
  let s = escapeHtml(String(t == null ? '' : t));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*+/g, '');
  return s;
}
// Comisión ML de la categoría del P2: de los propios (misma cat) o de la tabla local por hoja.
function p2CatCommission(report, item) {
  const ps = (report && report.own && report.own.products) || [];
  const c = ps.map(p => p.comPct).find(v => v > 0); if (c) return c;
  const idxs = mlCatIndex().get(normalize((item && item.leaf) || ''));
  if (idxs && idxs.length) return ML_CATEGORIES[idxs[0]].cost || 0;
  return 13;   // fallback promedio ML
}
// FOB objetivo (USD) para lograr TARGET_MARGIN de margen de CONTRIBUCIÓN a un precio de venta dado.
// Ejercicio inverso al de la app: parte del packaging deducido por la IA (dims cm + peso kg).
const P2_TARGET_MARGIN = 0.33;
function targetFob(price, comPct, pkg) {
  price = parseFloat(price) || 0; if (!price || !pkg) return null;
  const l = +pkg.l || 0, a = +pkg.a || 0, al = +pkg.al || 0, p = +pkg.p || 0;
  if (!l || !a || !al) return null;
  const weight = billableWeight(p, al, a, l, VOL_DIVISOR);
  const ship = mlShipping(price, weight, false, cfg).cost;
  const cogsTarget = price * (1 - P2_TARGET_MARGIN - (comPct || 0) / 100) - ship;   // COGS máximo que da 33%
  if (cogsTarget <= 0) return null;
  const cbmUnit = (al * a * l) / 1e6;   // m³ (dims en cm)
  const fob = cogsTarget / (cfg.dolar * (1 + (cfg.iva || 0) / 100)) - cbmUnit * cfg.factorCBM;
  return fob > 0 ? fob : null;   // USD
}
// Margen de contribución resultante a un precio y un FOB dados (round-trip del ejercicio inverso).
function marginAt(price, fobUsd, comPct, pkg) {
  if (!pkg) return null;
  const l = +pkg.l || 0, a = +pkg.a || 0, al = +pkg.al || 0, p = +pkg.p || 0;
  if (!l || !a || !al || !(price > 0)) return null;
  const cbmUnit = (al * a * l) / 1e6;
  const cogs = computeLanded(fobUsd, cbmUnit, cfg.factorCBM, cfg.dolar, cfg, 0);
  const weight = billableWeight(p, al, a, l, VOL_DIVISOR);
  return Math.round(computeChannel('ml', price, cogs, comPct || 0, weight, false, cfg).marginPct);
}
function targetFobTag(precio, comPct, pkg) {
  const p = parseFloat(precio) || 0;
  let s = '';
  if (p > 0) s += ` <span style="color:var(--ink);font-weight:700">· Ticket $${Math.round(p).toLocaleString('es-CL')}</span>`;
  const f = targetFob(p, comPct, pkg);
  if (f) {
    s += ` <span style="color:var(--accent-d);font-weight:700" title="Costo FOB de fábrica que necesitas para ~33% de margen de contribución a ese precio (packaging estimado por IA)">· FOB objetivo ~US$${f.toFixed(1)}</span>`;
    const mg = marginAt(p, f, comPct, pkg);
    if (mg != null) s += ` <span style="color:var(--good);font-weight:700" title="Margen de contribución real de la app a ese FOB y ticket (comisión de la categoría + envío)">· Margen ~${mg}%</span>`;
  }
  return s;
}

// --- Referencias de producto en Amazon (Rainforest) con verificación IA ---
// Botón por sugerencia; al lado un contenedor .amzRefs donde se pintan las tarjetas.
function amzBtn(query, desc) {
  const q = (query || '').toString().slice(0, 120), d = (desc || '').toString().slice(0, 240);
  if (!q) return '';
  return `<button class="btn ghost" style="font-size:11px;padding:3px 9px;margin-top:4px" data-q="${escapeHtml(q)}" data-d="${escapeHtml(d)}" onclick="amazonRefsFromBtn(this)">🔎 Ver en Amazon</button><div class="amzRefs"></div>`;
}
async function amazonRefsFromBtn(btn) {
  const box = btn.parentElement.querySelector('.amzRefs'); if (!box) return;
  if (btn._busy) return; btn._busy = true; const old = btn.textContent; btn.textContent = '🔎 buscando…';
  box.innerHTML = '<span class="muted small">Buscando en Amazon y verificando…</span>';
  try {
    const j = await (await fetch(api('/api/amazon'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: btn.dataset.q, num: 3 }) })).json();
    if (!j || j.error) { box.innerHTML = '<span class="muted small">' + escapeHtml(j && j.error ? j.error : 'Sin respuesta de Amazon.') + '</span>'; return; }
    if (!j.candidates || !j.candidates.length) { box.innerHTML = '<span class="muted small">Sin resultados en Amazon para esa búsqueda.</span>'; return; }
    const verdicts = await amazonVerify(btn.dataset.d, j.candidates);
    const good = j.candidates.map((c, i) => ({ ...c, v: verdicts[i] })).filter(c => c.v && c.v.match);
    box.innerHTML = good.length ? good.map(amzCard).join('')
      : '<span class="muted small">Ningún resultado de Amazon calzó con la sugerencia (verificado por IA).</span>';
  } catch (e) { box.innerHTML = '<span class="muted small">Error consultando Amazon.</span>'; }
  finally { btn.textContent = old; btn._busy = false; }
}
// La IA entra a las specs de cada candidato y confirma si REALMENTE es el producto sugerido.
async function amazonVerify(desc, candidates) {
  const cfg = loadCfg(country);
  const list = candidates.map((c, i) => `${i + 1}) ${c.title} | ${(c.specs || '').slice(0, 300)}`).join('\n');
  const prompt = 'Producto que ET Brands quiere lanzar (sugerencia): ' + desc + '\n\nCandidatos de Amazon (título | specs de la ficha):\n' + list +
    '\n\nPara cada candidato, di si es EFECTIVAMENTE ese producto (mismo tipo y specs clave compatibles). Sé estricto: ante la duda, false.\nDevuelve SOLO JSON: {"matches":[{"i":<número 1-based>,"match":true|false,"razon":"máx 55 car"}]}';
  const raw = await aiText(prompt, cfg, { maxTokens: 500 });
  const j = parseJSONLoose(raw); const out = {};
  if (j && Array.isArray(j.matches)) for (const m of j.matches) if (m && m.i) out[m.i - 1] = m;
  return out;
}
function amzCard(c) {
  const esc = escapeHtml;
  return `<a href="${esc(c.link)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;background:#121215;border:1px solid var(--line);border-radius:8px;padding:6px;margin:4px 0;text-decoration:none;color:var(--ink)">` +
    (c.image ? `<img src="${esc(c.image)}" alt="" style="width:46px;height:46px;object-fit:contain;background:#fff;border-radius:4px;flex:none">` : '') +
    `<div style="flex:1;min-width:0"><div style="font-size:11px;line-height:1.3;max-height:2.6em;overflow:hidden">${esc(c.title)}</div>` +
    `<div style="font-size:11px;color:var(--muted);margin-top:2px">${c.price ? '<b style="color:var(--ink)">' + esc(String(c.price)) + '</b>' : ''}${c.rating ? ' · ⭐' + Number(c.rating) + (c.reviews ? ' (' + Number(c.reviews).toLocaleString('es-CL') + ')' : '') : ''} · <span style="color:var(--good)" title="Verificado por IA">✓ ${esc((c.v && c.v.razon) || 'verificado')}</span></div></div></a>`;
}

// --- Batch: pre-analizar el top N por cuota x seller (reanudable, throttleado por mlGate). ---
let _p2Batch = null;
async function runP2Batch(n, force) {
  if (country === 'co') { alert('El pre-análisis con datos de ML está disponible por ahora solo para Chile.'); return; }
  if (_p2Batch && _p2Batch.running) return;
  await loadBizCtx();   // asegura el contexto de negocio antes de arrancar
  if (!_catAll || !_catAll.length) { try { _catAll = await catLoad(); } catch (e) {} }   // catálogo local para el match del P2
  const cats = _researchAll.filter(x => (parseFloat(x.ventasGmv) || 0) > 0)
    .slice().sort((a, b) => (parseFloat(b.ventasGmv) || 0) - (parseFloat(a.ventasGmv) || 0)).slice(0, n);
  if (!cats.length) { alert('No hay categorías con ventas para analizar. Importa datos primero.'); return; }
  _p2Batch = { running: true, total: cats.length, done: 0, ok: 0, fail: 0, skip: 0, stop: false, force: !!force, t0: Date.now() };
  p2BatchUI();
  // Timeout por ítem: si un análisis se cuelga (fetch/IA sin responder), no congela el batch.
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  try {
  for (const item of cats) {
    if (_p2Batch.stop) break;
    try {
      const prev = await withTimeout(p2CacheGet(item.id), 30000).catch(() => null);
      if (!force && prev && prev.report) { _p2Batch.skip++; }   // reanudable: ya estaba (salvo force)
      else {
        const report = await withTimeout(computeP2Report(item), 120000);
        if (prev && prev.report) { if (prev.report.deep) report.deep = prev.report.deep; if (prev.report.chat) report.chat = prev.report.chat; }   // conserva profundo + chat
        await withTimeout(p2CachePut(item.id, report), 30000); _p2Batch.ok++;
      }
    } catch (e) { _p2Batch.fail++; }
    _p2Batch.done++;
    p2BatchUI();
    if (_p2Batch.done % 25 === 0) refreshP2Scores();   // refresca P2/Opportunity en vivo cada 25 categorías
  }
  } finally { _p2Batch.running = false; _p2Batch.stop = false; p2BatchUI(); refreshP2Scores(); }
}
// Recarga el índice P2 (dif/conc) y repinta la tabla si está visible → el Opportunity Score se actualiza solo.
function refreshP2Scores() { loadP2Index().then(() => { const t = $('tabResearch'); if (t && !t.classList.contains('hidden')) paintResearch(); }).catch(() => {}); }
function p2BatchUI() {
  const b = _p2Batch;
  const bar = $('p2BatchBar'), fill = $('p2BatchFill'), txt = $('p2BatchTxt'), btn = $('p2BatchBtn'), stop = $('p2BatchStop');
  const running = !!(b && b.running && !b.stop && b.done < b.total);   // corre de verdad (no pedido parar, no completado)
  if (stop) stop.classList.toggle('hidden', !running);
  if (btn) btn.classList.toggle('hidden', running);
  if (!b) { if (bar) bar.classList.add('hidden'); return; }
  if (bar) bar.classList.toggle('hidden', !b.running && b.done === 0);
  if (fill) fill.style.width = (b.total ? Math.round(b.done / b.total * 100) : 0) + '%';
  if (txt) {
    const elapsed = (Date.now() - b.t0) / 1000;
    const rate = b.done > 0 ? elapsed / b.done : 0;
    const etaMin = b.running && rate ? Math.ceil((b.total - b.done) * rate / 60) : 0;
    txt.innerHTML = `Pre-análisis${b.force ? ' (sobrescribir)' : ''}: <b>${b.done}/${b.total}</b> · ${b.force ? 're-analizadas' : 'nuevas'} ${b.ok}` + (b.force ? '' : ` · ya estaban ${b.skip}`) +
      (b.fail ? ` · fallos ${b.fail}` : '') +
      (b.running ? ` · ~${etaMin} min restantes` : ' · <b style="color:var(--good)">listo ✓</b>');
  }
}
// Carga silenciosa del reporte cacheado al abrir la categoría (no analiza, solo muestra si existe).
async function p2LoadCached(item) {
  if (!item) return;
  try {
    const c = await (await fetch(api('/api/p2?id=' + encodeURIComponent(item.id)))).json();
    if (c && c.report && _rdItem && _rdItem.id === item.id) { $('p2Panel').classList.remove('hidden'); renderP2(c.report, item, c.ts); }
  } catch (e) {}
}
async function runP2(item, force) {
  if (!item || _p2Running) return;
  _p2Running = true;
  const host = $('p2Panel'); host.classList.remove('hidden');
  const load = msg => { host.innerHTML = '<div class="p2load"><div class="p2spin"></div><div>' + escapeHtml(msg) + '</div></div>'; };
  try {
    // 0) Cache (salvo que se fuerce recomputar)
    if (!force) {
      load('Buscando análisis guardado…');
      try { const c = await (await fetch(api('/api/p2?id=' + encodeURIComponent(item.id)))).json(); if (c && c.report) { renderP2(c.report, item, c.ts); _p2Running = false; return; } } catch (e) {}
    }
    if (country === 'co') { host.innerHTML = '<div class="p2err">El análisis P2 con datos de ML está disponible por ahora solo para Chile.</div>'; _p2Running = false; return; }

    const report = await computeP2Report(item, load);
    try { const prev = await p2CacheGet(item.id); if (prev && prev.report) { if (prev.report.deep) report.deep = prev.report.deep; if (prev.report.chat) report.chat = prev.report.chat; } } catch (e) {}   // conserva profundo + chat al recalcular
    renderP2(report, item, Date.now());
    try { await p2CachePut(item.id, report); } catch (e) {}
    refreshP2Scores();   // el nuevo P2 actualiza P2/Opportunity en la tabla
  } catch (e) {
    host.innerHTML = '<div class="p2err">No se pudo completar el análisis: ' + escapeHtml(String(e.message || e)) + '<br><button class="btn" style="margin-top:8px" onclick="runP2(_rdItem,true)">Reintentar</button></div>';
  } finally { _p2Running = false; }
}

/* --- Contexto de negocio de ET Brands: se antepone a TODOS los prompts de P2 para que
   la IA diagnostique según el modelo real (marcas propias, importación, etc.). Editable
   y guardado en KV (compartido por el equipo). Es "entrenamiento por contexto" (few-shot):
   no reentrena el modelo, pero le da el marco en cada consulta. --- */
const P2_BIZ_DEFAULT = `MODELO DE NEGOCIO DE ET BRANDS (tenlo SIEMPRE presente al diagnosticar):
- ET Brands IMPORTA sus propios productos desde China y los vende en Mercado Libre Chile (y Falabella).
- SOLO vende productos que importa ET Brands, bajo MARCAS 100% PROPIAS (ej.: Hosser, Zeker, Howell, Overfit, Duke, Ibrah, Colton, Galanta, Homely, Luxgear, Planex). NO revende marcas de terceros.
- Por eso las oportunidades deben ser: CREAR o MEJORAR un producto de marca propia para importar y diferenciarlo de la competencia (que suele ser otros importadores/revendedores, marcas chicas o marcas grandes).
- Prioriza upgrades y bundles BARATOS de fabricar en China pero de ALTO VALOR PERCIBIDO, que habiliten un ticket más alto y mejor margen.
- Nunca recomiendes "revender la marca X" ni "ser distribuidor de X". Recomienda con qué PRODUCTO PROPIO entrar, qué specs priorizar y cómo diferenciarlo.
- Considera logística de Mercado Libre (Full) y que el costeo parte del FOB China + factor CBM.`;
let _bizCtx = null;
async function loadBizCtx() {
  if (_bizCtx != null) return;
  try { const c = await (await fetch(api('/api/p2?id=__bizctx'))).json(); _bizCtx = (c && c.report && typeof c.report.text === 'string') ? c.report.text : ''; }
  catch (e) { _bizCtx = ''; }
}
function bizContext() { return (_bizCtx && _bizCtx.trim()) ? _bizCtx.trim() : P2_BIZ_DEFAULT; }
async function openP2CtxModal() { await loadBizCtx(); $('p2CtxText').value = bizContext(); $('p2CtxStatus').textContent = ''; $('p2CtxOverlay').classList.remove('hidden'); }
async function saveP2Ctx() {
  const text = $('p2CtxText').value || '';
  $('p2CtxStatus').textContent = 'Guardando…';
  try { await p2CachePut('__bizctx', { text }); _bizCtx = text; $('p2CtxStatus').innerHTML = '<span style="color:var(--good)">Guardado ✓ · aplica a los próximos análisis</span>'; }
  catch (e) { $('p2CtxStatus').textContent = 'Error al guardar: ' + (e.message || e); }
}

async function p2AI(item, stats, products, reviews, own) {
  await loadBizCtx();
  const cfg = loadCfg(country);
  const seas = stats.seasonality.map(s => s.mo + ' ' + s.idx).join(', ');
  const prod = products.map(p => '#' + p.pos + ' ' + p.name + ' | ' + p.attrs).join('\n');
  const revTxt = (reviews || []).map(r => r.name + ' (' + (r.avg || '?') + '★, ' + (r.total || 0) + '): ' + (r.samples || []).map(s => s.rate + '★ "' + s.content + '"').join(' | ')).join('\n');
  const ownTxt = p2OwnTxt(own);
  const fb = p2Feedback(item.id);
  const prompt =
    bizContext() + '\n\n' +
    'Eres analista de sourcing de ET Brands. Analiza la categoría "' + item.leaf + '" (' + item.l1 + ') para decidir si conviene REFORZAR el catálogo o entrar con un producto NUEVO de marca propia, y con cuál.\n\n' +
    (ownTxt ? ('CATÁLOGO PROPIO ACTUAL DE ET BRANDS EN ESTA CATEGORÍA (marca real ' + (own.brand ? '"' + own.brand + '"' : '') + ', costo y velocidad de venta):\n' + ownTxt + '\nUsa SIEMPRE la marca propia REAL de arriba (NO inventes marcas). NO sugieras "desarrollar" un producto que ya existe en esta lista; sugiere lo que FALTA (specs/segmentos sin cubrir) o mejoras a lo existente. Aprovecha qué se vende rápido (velocidad) y el costo para estimar viabilidad.\n\n') :
      'NOTA: no se encontró catálogo propio en esta categoría (quizás ET Brands aún no vende acá). Usa la marca propia que corresponda al rubro.\n\n') +
    'ESTACIONALIDAD (índice 100=promedio, prom. 3 años): ' + seas + '\n' +
    'TENDENCIA YoY: ' + (stats.trend.yoy != null ? stats.trend.yoy.toFixed(1) + '%' : 's/d') + ' (' + stats.trend.dir + ')\n' +
    'CUOTA x vendedor: ' + (stats.cuota.clase) + ' (percentil ' + (stats.cuota.pct || '?') + '). IMPORTANTE: es el ingreso promedio por vendedor de TODA la categoría (' + (stats.competidores ? Math.round(stats.competidores) + ' vendedores' : 'el mercado') + '), NO la participación de ET Brands. Percentil alto = categoría donde cada vendedor factura mucho (atractiva), NO significa que ET Brands domine. ET Brands es solo uno más salvo que el catálogo propio de arriba diga lo contrario.\n\n' +
    'TOP PRODUCTOS MÁS VENDIDOS DEL MERCADO (ML, con specs):\n' + (prod || '(sin datos)') + '\n\n' +
    'RESEÑAS (muestras reales):\n' + (revTxt || '(sin datos)') + '\n\n' +
    (fb ? 'FEEDBACK PREVIO DEL EQUIPO (respétalo): ' + fb + '\n\n' : '') +
    'REGLAS DE ESTILO: sé conciso y escaneable. NO uses markdown (nada de ** ni #). Frases cortas y concretas, con números cuando ayude. Respeta los límites de caracteres.\n' +
    'Devuelve SOLO un JSON con esta forma exacta:\n' +
    '{"estacionalidad":"1 frase: meses peak/valle y qué hacer (máx 140 car)","cuota":"1 frase sobre el atractivo de la categoría; NO digas que ET Brands domina salvo evidencia (máx 130 car)","tendencia":"1 frase (máx 110 car)",' +
    '"clusters":[{"nombre":"subcategoría por specs","chips":["FHD","24-27\\""],"pos":[2,3,5],"peso":"8/16"}],' +
    '"gap":"dónde hay demanda con poca oferta, con números (máx 200 car)","reviewOps":"queja recurrente = oportunidad, concreto (máx 160 car)",' +
    '"upgrades":[{"costo":"BAJO|MEDIO|ALTO","titulo":"3-6 palabras","texto":"por qué (barato de fabricar, alto valor), máx 110 car","precio":<precio de venta objetivo CLP, entero>,"pkg":{"l":<largo cm>,"a":<ancho cm>,"al":<alto cm>,"p":<peso kg>},"query":"2-5 keywords EN para Amazon"}],' +
    '"bundles":[{"nombre":"nombre del set (3-5 palabras)","para":"segmento objetivo","texto":"qué incluye y por qué, máx 90 car","precio":<precio de venta objetivo CLP, entero>,"pkg":{"l":<largo cm>,"a":<ancho cm>,"al":<alto cm>,"p":<peso kg>},"query":"2-5 keywords EN para Amazon"}],' +
    '"difScore":<0-100>,"difRazon":"1 frase máx 90 car","fitScore":<0-100>,"fitRazon":"1 frase máx 90 car"}\n' +
    'El "difScore" (0-100) = qué tan NATURAL/factible es diferenciarse con marca propia: 100 = upgrades/bundles obvios, baratos de fabricar y de alto valor; 0 = tuviste que forzar ideas poco realistas.\n' +
    'El "fitScore" (0-100) = qué tan bien calza el producto típico con lo que ET Brands hace bien: suma si es pequeño y liviano (<15 kg físico/volumétrico); resta fuerte si requiere certificaciones difíciles (SEC, cosméticos, ingeribles) o si hay que competir con marcas ultra reconocidas en productos muy difíciles (notebooks, celulares, TVs). Sé honesto.\n' +
    'Para CADA upgrade y bundle incluye "precio" (precio de venta objetivo en CLP, entero sin puntos) y "pkg" = dimensiones del PACKAGING/caja de envío en cm (l=largo, a=ancho, al=alto) y peso en kg (p), estimados de forma realista para ese producto. Con eso la app calcula el FOB objetivo.\n' +
    'REGLAS CRÍTICAS: (1) NO sugieras algo que YA EXISTE en el catálogo propio de arriba (revisa specs; ej. si ya hay un curvo 27" 165Hz, no lo propongas). Si el mejor movimiento es sobre un producto que ya tienes, dilo como "mejorar listing/precio de [SKU]", no como producto nuevo. (2) Ancla cada sugerencia al top real (specs/precios/reseñas) y usa precios DENTRO del rango real del mercado.';
  const raw = await aiText(prompt, cfg, { maxTokens: 3500 });
  return parseJSONLoose(raw) || { _err: 'La IA no devolvió JSON válido' };
}

// Análisis P2 con VISIÓN: manda las fotos (2 por producto) de los top del mercado y de
// TUS productos, para clusterizar bien, ubicar tus productos en su cluster y saber qué falta.
async function p2VisionAI(item, stats, products, reviews, own) {
  await loadBizCtx();
  const cfg = loadCfg(country);
  const withPics = (products || []).filter(p => p.pics && p.pics.length);
  const ownWithPics = (own && own.products || []).filter(p => p.pics && p.pics.length);
  if (!withPics.length && !ownWithPics.length) return { _err: 'sin fotos para visión' };
  const img = u => ({ type: 'image', source: { type: 'url', url: u } });
  const txt = t => ({ type: 'text', text: t });
  const seas = stats.seasonality.map(s => s.mo + ' ' + s.idx).join(', ');
  const revByPos = {}; (reviews || []).forEach(r => { revByPos[r.pos] = (r.samples || []).map(s => s.rate + '★"' + (s.content || '').slice(0, 90) + '"').join(' | '); });
  const ownTxt = p2OwnTxt(own);
  const fb = p2Feedback(item.id);

  const content = [];
  content.push(txt(
    bizContext() + '\n\n' +
    'Eres analista de sourcing de ET Brands. Vas a analizar la categoría "' + item.leaf + '" (' + item.l1 + ') MIRANDO LAS FOTOS, fichas y reseñas de cada producto (del mercado y los propios) para: (1) clusterizar los top por specs/materialidad/formato REALES que ves en las fotos, (2) ubicar CADA producto propio en su cluster y decir qué le falta, (3) proponer con qué producto propio entrar o mejorar.\n\n' +
    (ownTxt ? ('TUS PRODUCTOS ACTUALES (marca real ' + (own.brand ? '"' + own.brand + '"' : '') + '; abajo van sus fotos):\n' + ownTxt + '\nNO sugieras "desarrollar" algo que ya tienes (míralo en las fotos: formato, materialidad, si ya viene enrollado/comprimido, etc.). Sugiere lo que FALTA de verdad.\n\n') : 'NOTA: no hay catálogo propio detectado en esta categoría.\n\n') +
    'ESTACIONALIDAD (100=prom): ' + seas + '\nTENDENCIA YoY: ' + (stats.trend.yoy != null ? stats.trend.yoy.toFixed(1) + '%' : 's/d') + ' (' + stats.trend.dir + ')\n' +
    'CUOTA x vendedor: ' + stats.cuota.clase + ' (pct ' + (stats.cuota.pct || '?') + ') — promedio de TODA la categoría, NO de ET Brands.\n' +
    (fb ? '\nFEEDBACK PREVIO DEL EQUIPO (respétalo): ' + fb + '\n' : '') +
    '\nA CONTINUACIÓN, cada producto con su ficha y 1-2 fotos. Primero los TOP del mercado, luego TUS productos.'
  ));
  for (const p of withPics) {
    content.push(txt('\nTOP #' + p.pos + ' — ' + p.name + (p.brand ? ' [' + p.brand + ']' : '') + '\nSpecs: ' + (p.attrs || 's/d') + (revByPos[p.pos] ? '\nReseñas: ' + revByPos[p.pos] : '')));
    p.pics.slice(0, 2).forEach(u => content.push(img(u)));
  }
  for (const p of ownWithPics) {
    content.push(txt('\nTU PRODUCTO [' + p.sku + '] — ' + p.name + '\nSpecs: ' + (p.attrs || 's/d') + ' · vende ' + (p.vel != null ? p.vel + ' u/sem' : 's/d') + ' · margen ' + (p.margin != null ? p.margin + '%' : 's/d')));
    p.pics.slice(0, 2).forEach(u => content.push(img(u)));
  }
  content.push(txt(
    '\nAhora devuelve SOLO un JSON (sin markdown, frases cortas, respeta límites):\n' +
    '{"estacionalidad":"1 frase (máx 140 car)","cuota":"1 frase; no digas que ET Brands domina salvo evidencia (máx 130 car)","tendencia":"1 frase (máx 110 car)",' +
    '"clusters":[{"nombre":"subcategoría por specs/materialidad","chips":["rasgos clave"],"pos":[nº de TODOS los top de este cluster],"ownSkus":["SKUs propios que caen aquí"]}],' +
    '"ownAnalysis":[{"sku":"SKU propio","tipo":"qué es REALMENTE según sus fotos (formato/materialidad)","cluster":"a qué cluster pertenece","falta":"qué le falta vs el cluster/competencia, concreto (máx 120 car)"}],' +
    '"gap":"dónde hay demanda con poca oferta, con números (máx 200 car)","reviewOps":"queja recurrente = oportunidad (máx 160 car)",' +
    '"upgrades":[{"costo":"BAJO|MEDIO|ALTO","titulo":"3-6 palabras","texto":"por qué, máx 110 car","precio":<CLP entero>,"pkg":{"l":<cm>,"a":<cm>,"al":<cm>,"p":<kg>},"query":"2-5 keywords en INGLÉS para buscar este producto en Amazon"}],' +
    '"bundles":[{"nombre":"3-5 palabras","para":"segmento","texto":"qué incluye, máx 90 car","precio":<CLP entero>,"pkg":{"l":<cm>,"a":<cm>,"al":<cm>,"p":<kg>},"query":"2-5 keywords en INGLÉS del producto principal del set para Amazon"}],' +
    '"difScore":<0-100>,"difRazon":"por qué ese score, 1 frase máx 90 car",' +
    '"fitScore":<0-100>,"fitRazon":"por qué, 1 frase máx 90 car"}\n' +
    'El "difScore" (0-100) es tu autoevaluación de qué tan NATURAL y FACTIBLE es diferenciarse en esta categoría con marca propia: 100 = hay upgrades/bundles obvios, baratos de fabricar en China y de alto valor percibido, con espacio real vs. la competencia; 0 = tuviste que forzar ideas ultra creativas/poco realistas porque el mercado ya está muy resuelto o no hay cómo diferenciar barato. Sé honesto y calibrado.\n' +
    'El "fitScore" (0-100) evalúa qué tan bien calza el producto TÍPICO de esta categoría con lo que ET Brands sabe hacer bien: SUMA si es relativamente PEQUEÑO y LIVIANO (ideal < 15 kg de peso físico y volumétrico); RESTA fuerte si requiere certificaciones difíciles (SEC eléctrico, cosméticos, ingeribles/alimentos, etc.) salvo que valga mucho la pena; RESTA fuerte si hay que competir con marcas ULTRA reconocidas en productos MUY difíciles de desarrollar (ej. notebooks, computadores, celulares, TVs). 100 = pequeño, liviano, sin certificaciones complejas, sin marcas dominantes en algo difícil; 0 = pesado/voluminoso, o con certificación difícil, o dominado por marcas top en un producto muy difícil.\n' +
    'REGLAS CRÍTICAS:\n' +
    '1) NO propongas como upgrade/bundle/oportunidad algo que YA EXISTE en TUS PRODUCTOS (revisa sus specs y FOTOS de arriba). Ej: si ya tienes un curvo 27" 165Hz, NO lo sugieras como nuevo. Si el mejor movimiento es sobre un producto que ya tienes, enmárcalo como "mejorar listing/precio/fotos de [SKU]" (no como producto nuevo) o apunta a un segmento/specs que NO cubres.\n' +
    '2) Cada sugerencia debe estar ANCLADA en lo que realmente se vende en el top mostrado (specs, precios y reseñas que ves). El precio objetivo debe caer DENTRO del rango real del mercado de esta categoría. Nada genérico ni fuera de rango.\n' +
    '3) "pos" cubre TODOS los top mostrados; "ownAnalysis" incluye TODOS tus productos; "precio"=CLP y "pkg"=packaging estimado (para el FOB objetivo).'
  ));
  const raw = await aiText('', cfg, { content, maxTokens: 4500 });
  const j = parseJSONLoose(raw);
  return j || { _err: 'La IA (visión) no devolvió JSON válido' };
}

// Feedback por categoría (local): se inyecta al re-analizar para "entrenar" la IA.
function p2Feedback(catId) { try { return localStorage.getItem('p2fb_' + catId) || ''; } catch (e) { return ''; } }
function p2SaveFeedback(catId, note) { try { const cur = p2Feedback(catId); localStorage.setItem('p2fb_' + catId, (cur ? cur + ' | ' : '') + note); } catch (e) {} }

function renderP2(report, item, ts) {
  _p2Report = report; _p2Ts = ts; _p2Item = item;
  const host = $('p2Panel'); const s = report.stats || {}, ai = report.ai || {}, prods = report.products || [], revs = report.reviews || [];
  const byPos = {}; prods.forEach(p => byPos[p.pos] = p);
  const esc = escapeHtml;
  const bars = (s.seasonality || []).map(x => `<div class="p2bar ${x.idx >= 115 ? 'peak' : ''}"><div class="idx">${x.idx}</div><div class="col" style="height:${Math.max(6, Math.min(100, x.idx * 0.7))}%"></div><div class="mo">${x.mo}</div></div>`).join('');
  const trendCol = s.trend && s.trend.yoy != null ? (s.trend.yoy >= 0 ? 'var(--good)' : 'var(--bad)') : 'var(--muted)';
  const cuotaBadge = { ALTA: 'p2-hot', MEDIA: 'p2-mid', BAJA: 'p2-bad' }[(s.cuota || {}).clase] || 'p2-mid';
  const aiLine = (tag, txt) => txt ? `<div class="p2ai"><span class="tag">🤖 ${tag}</span>${mdBold(txt)}</div>` : '';
  const fbRow = sec => `<div class="p2fb"><button onclick="p2Fb(this,'${esc(item.id)}','${sec}',1)">👍</button><button onclick="p2Fb(this,'${esc(item.id)}','${sec}',0)">👎</button><button onclick="p2FbEdit('${esc(item.id)}','${sec}')">✏️ Corregir</button></div>`;

  const cliItem = p => `<li style="margin:2px 0"><a href="${esc(p.pdp)}" target="_blank" rel="noopener"><b style="color:var(--accent-d)">#${p.pos}</b> ${esc(p.name)}</a></li>`;
  let clusters = (ai.clusters || []).map(c => {
    const items = (c.pos || []).map(p => byPos[p]).filter(Boolean).sort((a, b) => a.pos - b.pos).map(cliItem).join('');
    const chips = (c.chips || []).map(ch => `<span class="chip">${esc(ch)}</span>`).join('');
    const ownTag = (c.ownSkus && c.ownSkus.length) ? `<div style="font-size:11px;color:var(--good);font-weight:700;margin-top:4px">🏷️ Tuyo acá: ${c.ownSkus.map(esc).join(', ')}</div>` : '';
    return `<div class="p2clcard"><div class="p2clhead"><span>${esc(c.nombre || '')}</span><span class="sh">${esc(c.peso || '')}</span></div><div class="chips">${chips}</div><ul class="p2plist" style="list-style:none;padding-left:0;margin:4px 0 0">${items}</ul>${ownTag}</div>`;
  }).join('');
  // Los que la IA no clasificó → bloque "Otros", para que aparezcan TODOS los del top.
  const covered = new Set(); (ai.clusters || []).forEach(c => (c.pos || []).forEach(p => covered.add(p)));
  const otros = prods.filter(p => !covered.has(p.pos)).sort((a, b) => a.pos - b.pos);
  if (otros.length) clusters += `<div class="p2clcard"><div class="p2clhead"><span>Otros</span><span class="sh">${otros.length}/${prods.length}</span></div><ul class="p2plist" style="list-style:none;padding-left:0;margin:4px 0 0">${otros.map(cliItem).join('')}</ul></div>`;

  const etbBrands = ['hosser', 'zeker', 'howell', 'overfit', 'duke', 'ibrah', 'colton', 'galanta', 'homely', 'luxgear', 'planex'];
  const own = prods.filter(p => etbBrands.includes((p.brand || '').toLowerCase()) || etbBrands.some(b => (p.name || '').toLowerCase().includes(b)));
  const etbHit = own.length ? `<div class="p2etb">🏷️ <b>Ya vendemos aquí:</b> ${own.map(p => `<a href="${esc(p.pdp)}" target="_blank" rel="noopener" style="color:var(--good);font-weight:700">#${p.pos} ${esc(p.name)}</a>`).join(', ')} (marca propia ET Brands).</div>` : '';

  const revBlock = revs.length ? (() => {
    const r = revs[0];
    const lv = r.levels || {}; const tot = r.total || 1;
    const bar = (n, c) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin:1px 0"><span>${n}★</span><div style="flex:1;height:6px;background:#2b2b31;border-radius:3px;overflow:hidden"><div style="height:100%;background:var(--accent);width:${Math.round((c || 0) / tot * 100)}%"></div></div><span>${c || 0}</span></div>`;
    const samples = (r.samples || []).map(x => `<div style="font-size:12px;margin:3px 0;color:${x.rate >= 4 ? '#a7d8a7' : '#e6a3a3'}">${x.rate}★ "${esc(x.content)}"</div>`).join('');
    return `<div style="font-size:13px;margin-bottom:6px"><b style="color:var(--accent-d);font-size:20px">${r.avg || '?'}★</b> · ${r.total || 0} reseñas · ${esc(r.name)} ${r.price ? '($' + Math.round(r.price).toLocaleString('es-CL') + ')' : ''}</div>${bar(5, lv.five_star)}${bar(1, lv.one_star)}<div style="margin-top:6px">${samples}</div>`;
  })() : '<span class="muted small">Sin reseñas disponibles para el top.</span>';

  const comPct = p2CatCommission(report, item);
  const deepTag = ai._deepRefined ? '<span class="verdict p2-good" style="font-size:9px" title="Actualizado con el ranking real del análisis profundo">✓ datos reales</span>' : '';
  const upgrades = (ai.upgrades || []).map(u => {
    const cc = /(baj|low)/i.test(u.costo) ? 'p2-good' : (/(alt|high)/i.test(u.costo) ? 'p2-bad' : 'p2-mid');
    const ti = u.titulo ? `<b>${esc(u.titulo)}</b> — ` : '';
    return `<div class="p2up"><span class="c ${cc}">costo ${esc(u.costo || '')}</span><div>${ti}${mdBold(u.texto || '')}${targetFobTag(u.precio, comPct, u.pkg)}<div style="margin-top:2px">${amzBtn(u.query || u.titulo, (u.titulo || '') + ' ' + (u.texto || ''))}</div></div></div>`;
  }).join('');
  const bundles = (ai.bundles || []).map(b => {
    if (b && typeof b === 'object') return `<li style="margin:6px 0"><b>${esc(b.nombre || '')}</b>${b.para ? ` <span class="muted small">· ${esc(b.para)}</span>` : ''}${b.texto ? `<div style="font-size:12px;color:var(--muted);margin-top:1px">${mdBold(b.texto)}${targetFobTag(b.precio, comPct, b.pkg)}</div>` : ''}<div style="margin-top:2px">${amzBtn(b.query || b.nombre, (b.nombre || '') + ' ' + (b.texto || ''))}</div></li>`;
    return `<li style="margin:5px 0">${mdBold(b)}</li>`;
  }).join('');
  const fmt = v => (v != null && !isNaN(v)) ? '$' + Math.round(v).toLocaleString('es-CL') : '–';

  const updStr = ts ? new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  host.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;flex-wrap:wrap"><h3 style="margin:0;font-size:15px;font-weight:800">🔬 Análisis P2 · ${esc(item.leaf)}</h3><div style="text-align:right"><button class="btn" style="font-size:12px;padding:7px 13px" onclick="runP2(_rdItem,true)">🔄 Actualizar análisis</button><div class="muted" style="font-size:11px;margin-top:4px">Última actualización: <b style="color:var(--ink)">${updStr}</b></div></div></div>` +
    (ai._err ? `<div class="p2err" style="margin-bottom:12px">La IA falló (${esc(ai._err)}). Se muestran los datos igual.</div>` : '') +
    `<div class="p2tool"><button class="btn ghost" style="font-size:12px;padding:7px 12px" id="p2ChatToggle">💬 Pregúntale a la IA</button><button class="btn ${report.deep ? 'ghost' : ''}" style="font-size:12px;padding:7px 12px" id="p2DeepToggle">📊 ${report.deep ? 'Re-analizar en profundidad' : 'Analizar en profundidad'}</button></div>` +
    ('own' in report ? renderP2Own(report.own) : '') +
    renderP2OwnAnalysis(ai) +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">📅</div><h3>Estacionalidad</h3></div><div class="p2bars">${bars}</div>${aiLine('Lectura', ai.estacionalidad)}${fbRow('estacionalidad')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">💰</div><h3>Atractivo · cuota por vendedor</h3><span class="verdict ${cuotaBadge}">${esc((s.cuota || {}).clase || '—')}</span></div><p style="margin:2px 0;font-size:13px">${fmt((s.cuota || {}).cuota)}/vendedor · percentil ${(s.cuota || {}).pct || '?'} · ${s.competidores ? Math.round(s.competidores) + ' vendedores' : ''}</p>${aiLine('Lectura', ai.cuota)}${fbRow('cuota')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">📈</div><h3>Tendencia</h3><span class="verdict ${s.trend && s.trend.yoy >= 0 ? 'p2-good' : 'p2-bad'}">${esc((s.trend || {}).dir || '—')}</span></div><p style="margin:2px 0"><b style="color:${trendCol};font-size:20px">${s.trend && s.trend.yoy != null ? (s.trend.yoy >= 0 ? '+' : '') + s.trend.yoy.toFixed(1) + '%' : '–'}</b> <span class="muted small">YoY (últimos 12m vs previos)</span></p>${aiLine('Lectura', ai.tendencia)}${fbRow('tendencia')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">🏆</div><h3>Top vendedores</h3></div><a class="btn" href="${esc(report.rankUrl || '#')}" target="_blank" rel="noopener">🏆 Ver ranking en Nubimetrics ↗</a></div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">🧩</div><h3>Top productos por subcategoría</h3><span class="verdict ${prods.length ? 'p2-good' : 'p2-mid'}">${prods.length} reales</span></div>${etbHit}${prods.length ? `<div class="p2clgrid">${clusters || '<span class="muted small">La IA no devolvió clusters.</span>'}</div>` : `<p class="small muted" style="margin:2px 0">Mercado Libre no publica un top de productos (best-sellers de catálogo) para esta categoría — es común en <b>repuestos, autopartes y nichos</b>. Para ver los productos reales del mercado acá, usa <b>“Analizar en profundidad”</b> e importa el ranking de Nubimetrics.</p>`}${fbRow('clusters')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">🎯</div><h3>Gap oferta / demanda</h3>${deepTag}<span class="verdict p2-hot">Oportunidad</span></div>${ai.gap ? `<div class="p2gap">${mdBold(ai.gap)}</div>` : '<span class="muted small">—</span>'}${fbRow('gap')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">⭐</div><h3>Diferenciación por reseñas</h3></div>${revBlock}${aiLine('Oportunidad', ai.reviewOps)}${fbRow('resenas')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">⚡</div><h3>Diferenciación por upgrades</h3>${deepTag}</div>${upgrades || '<span class="muted small">—</span>'}${fbRow('upgrades')}</div>` +
    `<div class="p2sec"><div class="p2sec-h"><div class="ic">📦</div><h3>Diferenciación por bundle</h3>${deepTag}</div><ul style="margin:4px 0 0;padding-left:18px;font-size:13px">${bundles || '<li class="muted">—</li>'}</ul>${fbRow('bundles')}</div>` +
    (report.deep ? renderP2Deep(report.deep) : '') +
    ((_p2ChatOpen || (report.chat && report.chat.length)) ? renderP2Chat(report) : '') +
    `<div class="hint" style="margin-top:6px">Datos reales: estacionalidad/cuota/tendencia (serie recolectada) + top productos y reseñas (ML vía ProfitGuard). Clusters y diferenciación: IA. El análisis profundo usa el ranking real de Nubimetrics que importes.</div>` +
    `<button id="p2ChatFab" class="btn p2fab" type="button" title="Pregúntale a la IA">💬 Preguntar a la IA</button>`;
  { const b = $('p2Btn'); if (b) b.style.display = 'none'; }   // ya hay reporte visible → el update se hace desde el propio panel
  wireP2Interactive(item);
}
function p2Fb(btn, catId, sec, ok) {
  btn.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); btn.classList.add('on');
  p2SaveFeedback(catId, sec + ': ' + (ok ? 'útil' : 'no sirvió'));
}
function p2FbEdit(catId, sec) {
  const t = prompt('¿Qué corregirías del análisis de "' + sec + '"? (se usará para afinar el próximo análisis de esta categoría)');
  if (t) { p2SaveFeedback(catId, sec + ': ' + t); alert('Guardado. Usa "↻ Recalcular" para re-analizar con tu corrección.'); }
}

/* --- P2 interactivo: "Pregúntale a la IA" + "Analizar en profundidad" (ranking Nubimetrics) --- */
let _p2Report = null, _p2Ts = 0, _p2Item = null, _p2ChatOpen = false, _p2DeepOpen = false, _p2Busy = false;

// "+$41.3M" → 41300000 · "+360" → 360 · "$115.321,00" → 115321
function nubiNum(v) {
  let s = String(v == null ? '' : v).replace(/[+$\s]/g, '').trim();
  if (!s) return 0;
  const suf = s.slice(-1);
  if (/[MmKk]/.test(suf)) { const b = parseFloat(s.slice(0, -1).replace(',', '.')); return isNaN(b) ? 0 : Math.round(b * (/[Mm]/.test(suf) ? 1e6 : 1e3)); }
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n;
}
async function parseRankingXlsx(file) {
  await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { defval: '' });
  const si = v => /^s/i.test(String(v || '').trim());
  return rows.map(r => {
    const ventas = nubiNum(_pick(r, ['Ventas en $', 'Ventas'])), unidades = nubiNum(_pick(r, ['Unidades vendidas', 'Unidades']));
    const precio = nubiNum(_pick(r, ['Último precio', 'Ultimo precio', 'Precio']));
    return {
      pos: nubiNum(_pick(r, ['#'])) || 0, titulo: String(_pick(r, ['Título', 'Titulo']) || '').trim(),
      vendedor: String(_pick(r, ['Vendedores', 'Vendedor']) || '').trim(), exposicion: String(_pick(r, ['Exposición']) || '').trim(),
      ventas, unidades, precio, ticket: (unidades > 0 && ventas > 0) ? Math.round(ventas / unidades) : precio,
      catalogo: si(_pick(r, ['Catálogo'])), flex: si(_pick(r, ['Flex'])), full: si(_pick(r, ['Full']))
    };
  }).filter(x => x.titulo);
}
function p2RankAgg(rows) {
  const ventas = rows.reduce((a, r) => a + (r.ventas || 0), 0), unidades = rows.reduce((a, r) => a + (r.unidades || 0), 0);
  const bySeller = {};
  for (const r of rows) { const k = r.vendedor || '?'; (bySeller[k] = bySeller[k] || { name: k, ventas: 0, n: 0 }); bySeller[k].ventas += r.ventas || 0; bySeller[k].n++; }
  const topSellers = Object.values(bySeller).sort((a, b) => b.ventas - a.ventas);
  return { ventas, unidades, topSellers, catPct: Math.round(rows.filter(r => r.catalogo).length / rows.length * 100), fullPct: Math.round(rows.filter(r => r.full).length / rows.length * 100) };
}
async function p2DeepAI(item, rows, agg) {
  await loadBizCtx();
  const cfg = loadCfg(country);
  const top = rows.slice(0, 60).map(r => `#${r.pos} ${r.titulo} | ${Math.round(r.unidades)}u $${(r.ventas / 1e6).toFixed(1)}M tk$${Math.round(r.ticket).toLocaleString('es-CL')} ${r.full ? 'FULL' : ''}${r.catalogo ? ' CAT' : ''} [${r.vendedor}]`).join('\n');
  const ownTxt = p2OwnTxt(_p2Report && _p2Report.own);
  const prompt =
    bizContext() + '\n\n' +
    'Eres analista de sourcing de ET Brands. Análisis PROFUNDO de la categoría "' + item.leaf + '" con el ranking REAL de Nubimetrics (top ' + rows.length + ', ventas y unidades EXACTAS del mes).\n\n' +
    (ownTxt ? ('CATÁLOGO PROPIO ACTUAL DE ET BRANDS' + (_p2Report.own && _p2Report.own.brand ? ' (marca "' + _p2Report.own.brand + '")' : '') + ':\n' + ownTxt + '\nUsa la marca propia REAL de arriba y NO propongas duplicar lo que ya existe; enfócate en huecos y mejoras.\n\n') : '') +
    'TOTALES top: ventas $' + (agg.ventas / 1e6).toFixed(0) + 'M · unidades ' + Math.round(agg.unidades).toLocaleString('es-CL') + '.\n' +
    'Vendedores líderes: ' + agg.topSellers.slice(0, 6).map(s => s.name + ' (' + (s.ventas / 1e6).toFixed(0) + 'M, ' + s.n + ' pub)').join(', ') + '.\n' +
    'Catálogo ' + agg.catPct + '% · Full ' + agg.fullPct + '% del top.\n\n' +
    'PUBLICACIONES (pos · título · unidades · ventas · ticket · logística · vendedor):\n' + top + '\n\n' +
    'REGLAS DE ESTILO: MUY conciso y escaneable. NO uses markdown (nada de ** ni #). Frases cortas con números. Respeta los límites de caracteres. Nada de párrafos largos.\n' +
    'Devuelve SOLO JSON: {"resumen":"2 frases accionables: entrar o no y con qué producto (máx 240 car)",' +
    '"clusters":[{"nombre":"subcategoría por specs (2-4 palabras)","unidades":<suma unidades del cluster>,"ejemplos":["título corto"]}],' +
    '"gap":"hueco concreto: muchas unidades con pocas publicaciones, con números (máx 200 car)",' +
    '"concentracion":"qué tan concentrado y qué implica para entrar (máx 180 car)",' +
    '"oportunidades":[{"titulo":"producto/acción (3-6 palabras)","detalle":"specs clave + segmento objetivo, máx 130 car","precio":<precio de venta objetivo CLP, entero>,"pkg":{"l":<largo cm>,"a":<ancho cm>,"al":<alto cm>,"p":<peso kg>},"query":"2-5 keywords EN para Amazon"}],' +
    '"upgrades":[{"costo":"BAJO|MEDIO|ALTO","titulo":"3-6 palabras","texto":"por qué, máx 110 car","precio":<CLP entero>,"pkg":{"l":<cm>,"a":<cm>,"al":<cm>,"p":<kg>}}],' +
    '"bundles":[{"nombre":"3-5 palabras","para":"segmento","texto":"qué incluye, máx 90 car","precio":<CLP entero>,"pkg":{"l":<cm>,"a":<cm>,"al":<cm>,"p":<kg>}}]}\n' +
    'Las "upgrades" y "bundles" ACTUALIZAN las diferenciaciones del análisis base con los datos REALES del ranking (precios y segmentos dentro del rango observado). REGLAS: NO dupliques lo que ET Brands ya tiene; ancla todo al ranking real; incluye "precio" (CLP) y "pkg" (packaging cm/kg) en oportunidades, upgrades y bundles para el FOB objetivo (33% margen contribución).';
  const raw = await aiText(prompt, cfg, { maxTokens: 3500 });
  return parseJSONLoose(raw) || { _err: 'La IA no devolvió JSON' };
}
// Diagnóstico por producto propio (del análisis con visión): qué es, en qué cluster cae, qué le falta.
function renderP2OwnAnalysis(ai) {
  const a = ai && ai.ownAnalysis; if (!a || !a.length) return '';
  const esc = escapeHtml;
  const rows = a.map(o => `<div style="margin:7px 0;font-size:12px;border-left:2px solid var(--line);padding-left:8px"><b>${esc(o.sku || '')}</b>${o.tipo ? ` <span class="muted">· ${esc(o.tipo)}</span>` : ''}${o.cluster ? ` <span style="color:var(--accent-d)">· ${esc(o.cluster)}</span>` : ''}${o.falta ? `<div style="color:var(--mid);margin-top:1px">Falta: ${mdBold(o.falta)}</div>` : ''}</div>`).join('');
  return `<div class="p2sec"><div class="p2sec-h"><div class="ic">🔎</div><h3>Diagnóstico de tus productos</h3><span class="verdict p2-good">visión IA</span></div>` +
    `<p class="small muted" style="margin:2px 0 6px">La IA miró las fotos y fichas de tus productos: qué son en realidad, en qué cluster caen y qué les falta vs. la competencia.</p>${rows}</div>`;
}
function renderP2Own(own) {
  const esc = escapeHtml;
  if (!own || !own.products || !own.products.length)
    return `<div class="p2sec"><div class="p2sec-h"><div class="ic">🏷️</div><h3>Tu catálogo actual</h3><span class="verdict p2-mid">sin productos</span></div><p class="small muted">No se encontraron productos propios de ET Brands en esta categoría (o el nombre no matcheó con ProfitGuard). La IA lo sabe y trata la categoría como entrada nueva.</p></div>`;
  const act = own.products.filter(p => p.active);
  const abcColor = { A: 'var(--good)', B: '#8fd18f', C: 'var(--mid)', D: 'var(--faint)', F: 'var(--bad)' };
  const abcCell = p => p.abc ? `<span style="font-weight:800;color:${abcColor[p.abc] || 'var(--muted)'}">${esc(p.abc)}</span>` : '–';
  const mCol = m => m >= 30 ? 'var(--good)' : (m >= 15 ? 'var(--mid)' : 'var(--bad)');
  const short = s => { s = String(s || ''); return s.length > 20 ? s.slice(0, 19) + '…' : s; };
  const clp = v => '$' + Math.round(v).toLocaleString('es-CL');
  const rows = act.slice(0, 16).map(p => `<tr><td title="${esc(p.name)}">${esc(short(p.name))}</td>` +
    `<td title="${esc(p.sku || '')}" style="font-variant-numeric:tabular-nums">${esc(p.sku || '–')}</td>` +
    `<td>${esc(p.brand || '')}</td>` +
    `<td style="text-align:center">${abcCell(p)}</td>` +
    `<td style="text-align:right"${p.velWeeks ? ` title="Promedio de ${p.velWeeks} semana${p.velWeeks === 1 ? '' : 's'} con ventas (con stock)"` : ''}>${p.vel != null ? `<b style="color:${p.vel > 0 ? 'var(--good)' : 'var(--muted)'};font-variant-numeric:tabular-nums">${p.vel}</b>` : '–'}</td>` +
    `<td style="text-align:right">${p.cost ? clp(p.cost) : '–'}</td>` +
    `<td style="text-align:right">${p.fob != null ? 'US$' + p.fob : '–'}</td>` +
    `<td style="text-align:right">${p.price ? clp(p.price) : '–'}</td>` +
    `<td style="text-align:right;font-weight:700;color:${p.margin != null ? mCol(p.margin) : 'var(--muted)'}">${p.margin != null ? p.margin + '%' : '–'}</td></tr>`).join('');
  return `<div class="p2sec"><div class="p2sec-h"><div class="ic">🏷️</div><h3>Tu catálogo actual</h3><span class="verdict p2-good">${own.brand ? esc(own.brand) + ' · ' : ''}${act.length} activo${act.length === 1 ? '' : 's'}</span></div>` +
    `<p class="small muted" style="margin:2px 0 6px">La velocidad se calcula en base a las últimas semanas en que el SKU tuvo stock.</p>` +
    `<table class="p2own" style="width:100%;table-layout:fixed;font-size:11px"><thead><tr><th style="text-align:left;width:20%">Producto</th><th style="text-align:left;width:13%">SKU</th><th style="text-align:left;width:11%">Marca</th><th style="text-align:center;width:7%" title="Rotación real: A=top ventas … F=congelado">Clase</th><th style="text-align:right;width:8%">Vel</th><th style="text-align:right;width:12%" title="Costo landed / COGS (CLP)">COGS</th><th style="text-align:right;width:10%" title="Costo FOB (USD)">FOB</th><th style="text-align:right;width:10%" title="Precio AON (CLP)">AON</th><th style="text-align:right;width:9%" title="Margen de contribución a precio AON (precio − COGS − comisión − envío)">Margen</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderP2Deep(deep) {
  const esc = escapeHtml, ai = deep.ai || {};
  const comPct = p2CatCommission(_p2Report, _p2Item);
  const per = deep.period ? ((RD_MESES[deep.period.month - 1] || '') + ' ' + deep.period.year) : '';
  const kpi = (l, v) => `<div style="flex:1;min-width:88px;background:#121215;border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">${l}</div><div style="font-size:17px;font-weight:800">${v}</div></div>`;
  const clusters = (ai.clusters || []).slice().sort((a, b) => (b.unidades || 0) - (a.unidades || 0));
  const cmax = clusters.reduce((m, c) => Math.max(m, c.unidades || 0), 0);
  const clBars = clusters.map(c => {
    const w = cmax ? Math.round((c.unidades || 0) / cmax * 100) : 0;
    return `<div style="margin:7px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><b>${esc(c.nombre || '')}</b><span class="muted">${c.unidades ? Math.round(c.unidades).toLocaleString('es-CL') + ' u' : ''}</span></div><div style="height:16px;background:var(--panel2);border-radius:4px;overflow:hidden;margin-top:2px"><div style="height:100%;width:${w}%;background:linear-gradient(90deg,var(--accent),var(--accent-d));border-radius:4px"></div></div>${(c.ejemplos && c.ejemplos[0]) ? `<div style="font-size:10px;color:var(--faint);margin-top:1px">ej: ${esc(c.ejemplos[0])}</div>` : ''}</div>`;
  }).join('');
  const sellers = (deep.agg && deep.agg.topSellers || []).slice(0, 6);
  const smax = sellers.reduce((m, s) => Math.max(m, s.ventas || 0), 0);
  const sBars = sellers.map(s => {
    const w = smax ? Math.round((s.ventas || 0) / smax * 100) : 0;
    return `<div style="margin:4px 0"><div style="display:flex;justify-content:space-between;font-size:11px"><span>${esc(s.name)}</span><span class="muted">$${(s.ventas / 1e6).toFixed(0)}M · ${s.n} pub</span></div><div style="height:12px;background:var(--panel2);border-radius:3px;overflow:hidden;margin-top:2px"><div style="height:100%;width:${w}%;background:#6aa9ff;border-radius:3px"></div></div></div>`;
  }).join('');
  return `<div class="p2sec" style="border-color:var(--accent)"><div class="p2sec-h"><div class="ic">🔬</div><h3>Análisis profundo · ranking real</h3><span class="verdict p2-hot">${esc(per)}</span></div>` +
    (ai._err ? `<div class="p2err">La IA falló (${esc(ai._err)}).</div>` : '') +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px">${kpi('Venta top', deep.tot ? '$' + (deep.tot.ventas / 1e6).toFixed(0) + 'M' : '–')}${kpi('Unidades', deep.tot ? Math.round(deep.tot.unidades).toLocaleString('es-CL') : '–')}${kpi('Catálogo', (deep.agg ? deep.agg.catPct : '?') + '%')}${kpi('Full', (deep.agg ? deep.agg.fullPct : '?') + '%')}</div>` +
    (ai.resumen ? `<div class="p2ai"><span class="tag">🤖 Resumen</span>${mdBold(ai.resumen)}</div>` : '') +
    (clBars ? `<div style="font-weight:800;font-size:12px;margin:12px 0 2px">📊 Demanda por subcategoría (unidades reales)</div>${clBars}` : '') +
    (ai.gap ? `<div class="p2gap" style="margin-top:10px"><b>🎯 Gap oferta/demanda:</b> ${mdBold(ai.gap)}</div>` : '') +
    (sBars ? `<div style="font-weight:800;font-size:12px;margin:12px 0 2px">🏪 Concentración por vendedor (ventas)</div>${sBars}${ai.concentracion ? `<div class="small muted" style="margin-top:4px">${mdBold(ai.concentracion)}</div>` : ''}` : '') +
    ((ai.oportunidades && ai.oportunidades.length) ? `<div style="margin-top:12px"><b style="font-size:12px">💡 Oportunidades:</b><div style="margin-top:4px">${ai.oportunidades.map(o => {
      if (o && typeof o === 'object') return `<div style="display:flex;gap:8px;margin:6px 0"><span style="color:var(--accent);font-weight:800">›</span><div><b style="font-size:13px">${esc(o.titulo || '')}</b>${o.detalle ? `<div style="font-size:12px;color:var(--muted);margin-top:1px">${mdBold(o.detalle)}${targetFobTag(o.precio, comPct, o.pkg)}</div>` : `<div>${targetFobTag(o.precio, comPct, o.pkg)}</div>`}<div style="margin-top:2px">${amzBtn(o.query || o.titulo, (o.titulo || '') + ' ' + (o.detalle || ''))}</div></div></div>`;
      return `<div style="display:flex;gap:8px;margin:6px 0"><span style="color:var(--accent);font-weight:800">›</span><div style="font-size:13px">${mdBold(o)}</div></div>`;
    }).join('')}</div></div>` : '') +
    `<div class="p2fb"><button onclick="openP2DeepModal()">↻ Reimportar / cambiar mes</button></div></div>`;
}
// Abre el popup de importación profunda (los selectores se pueblan la 1ª vez).
function openP2DeepModal() {
  const y = $('p2DeepYear'), mo = $('p2DeepMonth');
  if (y && !y.options.length) { const now = new Date().getFullYear(); let o = '<option value="">—</option>'; for (let yr = now; yr >= 2023; yr--) o += `<option value="${yr}">${yr}</option>`; y.innerHTML = o; }
  if (mo && !mo.options.length) mo.innerHTML = '<option value="">—</option>' + RD_MESES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  $('p2DeepStatus').textContent = ''; $('p2DeepFile').value = '';
  if (y) y.value = ''; if (mo) mo.value = '';   // vacíos por defecto (se autocompletan del nombre del archivo)
  if (_p2Item) $('p2DeepTitle').textContent = _p2Item.leaf;
  $('p2DeepOverlay').classList.remove('hidden');
}
async function runP2DeepImport() {
  const item = _p2Item; if (!item) return;
  const f = $('p2DeepFile').files[0], st = $('p2DeepStatus');
  if (!f) { st.textContent = 'Elegí el archivo .xlsx del ranking.'; return; }
  if (!$('p2DeepYear').value || !$('p2DeepMonth').value) { st.textContent = 'Elegí el año y el mes al que corresponde el ranking.'; return; }
  if (_p2Busy) return; _p2Busy = true; st.textContent = 'Leyendo Excel y analizando con IA…';
  try {
    const rows = await parseRankingXlsx(f); if (!rows.length) throw new Error('El Excel no tiene filas de ranking.');
    const agg = p2RankAgg(rows), ai = await p2DeepAI(item, rows, agg).catch(e => ({ _err: String(e.message || e) }));
    const yr = +$('p2DeepYear').value, mo = +$('p2DeepMonth').value;
    _p2Report.deep = { period: { year: yr, month: mo }, n: rows.length, tot: { ventas: agg.ventas, unidades: agg.unidades }, agg: { catPct: agg.catPct, fullPct: agg.fullPct, topSellers: agg.topSellers.slice(0, 8) }, ai, rows: rows.slice(0, 100).map(r => ({ pos: r.pos, titulo: r.titulo, unidades: r.unidades, ventas: r.ventas, ticket: r.ticket, vendedor: r.vendedor, full: r.full, catalogo: r.catalogo })) };
    // El análisis profundo (datos reales) ACTUALIZA las diferenciaciones y el gap de arriba.
    if (ai && !ai._err) {
      _p2Report.ai = _p2Report.ai || {};
      if (Array.isArray(ai.upgrades) && ai.upgrades.length) _p2Report.ai.upgrades = ai.upgrades;
      if (Array.isArray(ai.bundles) && ai.bundles.length) _p2Report.ai.bundles = ai.bundles;
      if (ai.gap) _p2Report.ai.gap = ai.gap;
      _p2Report.ai._deepRefined = true;
    }
    try { await p2CachePut(item.id, _p2Report); } catch (e) {}
    _p2Busy = false; $('p2DeepOverlay').classList.add('hidden'); renderP2(_p2Report, item, _p2Ts);
  } catch (e) { st.textContent = 'Error: ' + (e.message || e); _p2Busy = false; }
}
function renderP2Chat(report) {
  const esc = escapeHtml;
  const thread = (report.chat || []).map(m => `<div class="p2msg"><div class="q">🧑 ${esc(m.q)}</div><div class="a">🤖 ${esc(m.a)}</div></div>`).join('') ||
    '<div class="small muted">Preguntá lo que quieras sobre esta categoría (specs a priorizar, precio objetivo, riesgos, ideas de producto/bundle…). La IA responde con todo el contexto del análisis.</div>';
  return `<div class="p2chat"><div style="font-weight:800;font-size:13px;margin-bottom:2px">💬 Pregúntale a la IA</div>${thread}` +
    `<textarea id="p2ChatInput" placeholder="Ej: ¿qué specs priorizo para diferenciarme? ¿precio objetivo? ¿qué bundle tiene más sentido?"></textarea>` +
    `<div style="margin-top:6px"><button class="btn" id="p2ChatSend" style="font-size:12px;padding:7px 14px">Preguntar</button></div></div>`;
}
function p2ChatContext(report) {
  const s = report.stats || {}, ai = report.ai || {};
  let c = 'Categoría: ' + report.cat.leaf + ' (' + report.cat.l1 + ').\n';
  c += 'Estacionalidad (idx 100=prom): ' + (s.seasonality || []).map(x => x.mo + x.idx).join(' ') + '.\n';
  c += 'Cuota x vendedor: ' + ((s.cuota || {}).clase) + ' (pct ' + ((s.cuota || {}).pct) + ') — ingreso promedio por vendedor de TODA la categoría, NO la participación de ET Brands. Tendencia: ' + ((s.trend || {}).dir) + ' ' + ((s.trend || {}).yoy != null ? s.trend.yoy.toFixed(0) + '%' : '') + '. Ticket ~$' + Math.round(s.ticket || 0).toLocaleString('es-CL') + '.\n';
  c += 'Top productos ML: ' + (report.products || []).slice(0, 12).map(p => '#' + p.pos + ' ' + p.name).join('; ') + '.\n';
  const ownTxt = p2OwnTxt(report.own); if (ownTxt) c += 'CATÁLOGO PROPIO ET BRANDS' + (report.own && report.own.brand ? ' (marca ' + report.own.brand + ')' : '') + ':\n' + ownTxt + '\n';
  if (ai.clusters) c += 'Clusters: ' + ai.clusters.map(cl => cl.nombre).join(', ') + '.\n';
  if (ai.gap) c += 'Gap: ' + ai.gap + '\n';
  if (ai.reviewOps) c += 'Reseñas: ' + ai.reviewOps + '\n';
  if (report.deep && report.deep.ai) c += 'ANÁLISIS PROFUNDO (ranking real Nubimetrics): ' + (report.deep.ai.resumen || '') + ' Gap: ' + (report.deep.ai.gap || '') + '\n';
  return c;
}
async function p2Ask(item, question) {
  await loadBizCtx();
  const report = _p2Report, cfg = loadCfg(country);
  const hist = (report.chat || []).slice(-3).map(m => 'P: ' + m.q + '\nR: ' + m.a).join('\n');
  const prompt = bizContext() + '\n\nEres analista de sourcing de ET Brands. Responde la pregunta del equipo sobre esta categoría de forma accionable y concisa (máx ~130 palabras), consistente con el modelo de negocio de arriba. Si falta info, dilo y sugiere qué mirar.\n\nCONTEXTO DEL ANÁLISIS:\n' + p2ChatContext(report) + (hist ? '\nCONVERSACIÓN PREVIA:\n' + hist + '\n' : '') + '\nPREGUNTA: ' + question + '\n\nResponde en texto plano, directo.';
  return await aiText(prompt, cfg, { maxTokens: 700 });
}
function wireP2Interactive(item) {
  const host = $('p2Panel'); if (!host) return;
  const openChat = () => { _p2ChatOpen = true; renderP2(_p2Report, item, _p2Ts); const ta = $('p2Panel').querySelector('#p2ChatInput'); if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); } };
  const ct = host.querySelector('#p2ChatToggle'); if (ct) ct.onclick = () => { _p2ChatOpen = !_p2ChatOpen; renderP2(_p2Report, item, _p2Ts); };
  const fab = host.querySelector('#p2ChatFab'); if (fab) fab.onclick = openChat;   // botón sticky: chat desde cualquier parte
  const dt = host.querySelector('#p2DeepToggle'); if (dt) dt.onclick = openP2DeepModal;   // abre el popup
  const send = host.querySelector('#p2ChatSend');
  if (send) send.onclick = async () => {
    const ta = host.querySelector('#p2ChatInput'); const q = (ta && ta.value || '').trim(); if (!q || _p2Busy) return;
    _p2Busy = true; send.disabled = true; send.textContent = 'Pensando…';
    let a; try { a = await p2Ask(item, q); } catch (e) { a = '(Error: ' + (e.message || e) + ')'; }
    _p2Report.chat = _p2Report.chat || []; _p2Report.chat.push({ q, a });
    try { await p2CachePut(item.id, _p2Report); } catch (e) {}
    _p2Busy = false; renderP2(_p2Report, item, _p2Ts);
  };
}

async function importResearchJSON(file) {
  try {
    setResearchStatus('Leyendo ' + file.name + '…');
    let data; try { data = JSON.parse(await file.text()); } catch (e) { setResearchStatus('El archivo no es JSON válido.', true); return; }
    const arr = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
    if (!arr) { setResearchStatus('El JSON debe ser un array de categorías (o {items:[…]}).', true); return; }
    const items = arr.map(x => ({
      id: String(x.id || x.categoryId || x.path || ((x.l1 || '') + '|' + (x.leaf || ''))),
      l1: x.l1 || x.l1Name || '', leaf: x.leaf || x.leafName || x.name || '', path: x.path || '',
      ventasGmv: _num(x.ventasGmv != null ? x.ventasGmv : x.gmv),
      ticket: _num(x.ticket),
      competidores: _num(x.competidores != null ? x.competidores : x.sellersProfessional),
      canibalizacion: !!x.canibalizacion,
      serie: Array.isArray(x.serie) ? x.serie : []
    }));
    await researchReplace(items);
    _researchAll = items; _researchSig = JSON.stringify(items);
    paintResearch();
    setResearchStatus('✓ Importado: ' + items.length + ' categorías.');
  } catch (e) { setResearchStatus('Error importando: ' + e.message, true); }
}
function exportResearchCSV() {
  if (!_researchAll.length) { alert('No hay datos que exportar.'); return; }
  const head = ['Categoría L1', 'Categoría hoja', 'Canibalización', 'Ventas prom GMV 12m', 'Crec YoY 12m %', 'Ticket medio 12m', 'Competidores prof 12m', 'Cuota x seller'];
  const q = s => '"' + (s == null ? '' : s).toString().replace(/"/g, '""') + '"';
  const n = v => (v == null || v === '' || isNaN(v)) ? '' : Math.round(v);
  const p1 = v => (v == null || isNaN(v)) ? '' : v.toFixed(1);
  const lines = [head.join(';')];
  for (const x of _researchAll) lines.push([q(x.l1), q(x.leaf), (x.canibalizacion || _myCats.has(x.id)) ? 'Sí' : 'No', n(x.ventasGmv), p1(yoy12(x.serie)), n(x.ticket), n(x.competidores), n(researchCuota(x))].join(';'));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'investigacion_categorias.csv'; a.click();
}

/* ---------------- País (Chile / Colombia) ---------------- */
// Aplica al DOM el país activo: bandera activa, oculta Falabella en Colombia, ajusta etiquetas de moneda.
function applyCountryUI() {
  document.body.classList.toggle('co', country === 'co');
  document.querySelectorAll('.flag-btn').forEach(b => b.classList.toggle('active', b.dataset.country === country));
  const cur = country === 'co' ? 'COP' : 'CLP';
  const lblP = $('lblPrecio'); if (lblP) lblP.textContent = country === 'co' ? 'Precio de venta ML (COP, con IVA)' : 'Precio de venta (CLP, con IVA)';
  const lblD = $('lblDolar'); if (lblD) lblD.textContent = 'Dólar (' + cur + '/USD)';
}
// Cambia de país: parámetros y base de datos propios de cada uno.
function switchCountry(c) {
  if (c === country || (c !== 'cl' && c !== 'co')) return;
  saveCfg(cfg);                              // guarda los params del país que dejamos
  country = c; localStorage.setItem('mp_country', c);
  Object.assign(cfg, loadCfg(c));            // carga params del país nuevo (cfg es const → se muta)
  _histBackend = null; _catBackend = null;   // re-detectar backend
  _setSig = ''; _histSig = ''; _catSig = ''; _closedSig = ''; _researchSig = '';
  _researchBackend = null;
  applyCountryUI();
  bindCfgValues();
  nuevoProducto();                           // limpia el formulario
  loadView();                                // recarga la comparación del país
  if (!$('tabHist').classList.contains('hidden')) renderHistorial();
  if (!$('tabCat').classList.contains('hidden')) renderCatalogo();
  if (!$('tabClosed').classList.contains('hidden')) renderClosed();
  if (!$('tabResearch').classList.contains('hidden')) renderResearch();
  (async () => {                             // trae los parámetros compartidos del país
    if (await settingsLoad()) {
      bindCfgValues(); recompute(); renderHist();
      if (!$('tabHist').classList.contains('hidden')) renderHistorial();
      if (!$('tabCat').classList.contains('hidden')) renderCatalogo();
    }
    _setSig = JSON.stringify(SHARED_KEYS.map(k => cfg[k]));
  })();
  recompute();
}

/* ---------------- Panel de parámetros ---------------- */
function bindCfgValues() {
  $('cfgRep').value = String(cfg.fblaRepIndex);
  $('cfgIva').value = cfg.iva;
  $('cfgApiKey').value = cfg.apiKey || '';
  $('cfgFactorCBM').value = cfg.factorCBM;
  $('cfgDolar').value = cfg.dolar;
}
function bindCfg() {
  bindCfgValues();
  $('btnSaveCfg').onclick = () => {
    cfg.fblaRepIndex = parseInt($('cfgRep').value, 10) || 0;
    cfg.iva = parseFloat($('cfgIva').value) || 0;
    cfg.apiKey = $('cfgApiKey').value.trim();
    cfg.factorCBM = parseFloat($('cfgFactorCBM').value) || 0;
    cfg.dolar = parseFloat($('cfgDolar').value) || 0;
    saveCfg(cfg); settingsSave(); recompute(); renderHist();   // settingsSave: propaga al equipo
    if (!$('tabHist').classList.contains('hidden')) renderHistorial();   // recalcula el historial con los nuevos factor CBM / dólar
    if (!$('tabCat').classList.contains('hidden')) paintCatalogo();      // y el catálogo
    $('cfgSaved').textContent = '✓ guardado'; setTimeout(() => $('cfgSaved').textContent = '', 1500);
  };
  $('cfgToggle').onclick = () => $('cfgBody').classList.toggle('hidden');
}

/* ---------------- Init ---------------- */
function init() {
  // recompute en cualquier cambio de input numérico
  ['inpAlto','inpAncho','inpLargo','inpPeso','inpFob','inpPrecioML','inpPrecioFB','inpArancel','inpHs'].forEach(id => $(id).addEventListener('input', recompute));
  $('inpSuper').addEventListener('change', recompute);

  // deducción 3 s después de que el usuario deja de escribir (la IA tarda y consume cuota)
  $('inpNombre').addEventListener('input', debounce(autoDeduce, 3000));
  $('btnAI').addEventListener('click', () => { if (!deduceText()) { setAiStatus('Escribe primero el nombre del producto.', true); return; } autoDeduce(); });
  // Importar quote de proveedor (IA → Historial)
  { const b = $('btnImportQuote'); if (b) b.addEventListener('click', () => $('quoteFile').click()); }
  { const f = $('quoteFile'); if (f) f.addEventListener('change', e => { const file = e.target.files[0]; if (file) importQuoteFile(file); e.target.value = ''; }); }
  { const b = $('quoteClose'); if (b) b.onclick = () => $('quoteOverlay').classList.add('hidden'); }
  { const o = $('quoteOverlay'); if (o) o.onclick = e => { if (e.target === o) o.classList.add('hidden'); }; }
  { const b = $('quoteCommit'); if (b) b.onclick = commitQuote; }

  // selects de categoría (la categoría sugerida por IA queda seleccionada; se puede cambiar a mano)
  $('mlCatSelect').addEventListener('change', () => { state.mlCatIdx = parseInt($('mlCatSelect').value, 10); recompute(); });
  $('fblaCatSelect').addEventListener('change', () => { state.fblaCatIdx = parseInt($('fblaCatSelect').value, 10); recompute(); });
  // Buscador de categoría por texto (para corregir a mano entre las 4.000+ categorías)
  $('mlCatFilter').addEventListener('input', debounce(() => buildCatOptions('ml', $('mlCatFilter').value), 150));
  $('fblaCatFilter').addEventListener('input', debounce(() => buildCatOptions('fbla', $('fblaCatFilter').value), 150));

  // selector de país (banderas)
  document.querySelectorAll('.flag-btn').forEach(b => b.onclick = () => switchCountry(b.dataset.country));

  // pestañas + historial
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
  $('btnHistRefresh').onclick = renderHistorial;
  $('btnHistExport').onclick = exportHistorialCSV;
  $('histFilter').addEventListener('input', debounce(renderHistorial, 200));
  $('btnClosedRefresh').onclick = renderClosed;
  $('btnClosedExport').onclick = exportClosedCSV;
  $('closedFilter').addEventListener('input', debounce(paintClosed, 200));
  $('btnResearchExport').onclick = exportResearchCSV;
  $('btnResearchImport').onclick = () => $('researchFile').click();
  $('researchFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importResearchJSON(f); e.target.value = ''; });
  $('researchFilter').addEventListener('input', debounce(paintResearch, 200));
  { const b = $('btnResearchFilter'); if (b) b.onclick = openResearchFilter; }
  { const b = $('btnResearchClear'); if (b) b.onclick = clearResearchFilter; }
  { const b = $('researchFilterClose'); if (b) b.onclick = () => $('researchFilterOverlay').classList.add('hidden'); }
  { const o = $('researchFilterOverlay'); if (o) o.onclick = e => { if (e.target === o) o.classList.add('hidden'); }; }
  { const b = $('rfApply'); if (b) b.onclick = applyResearchFilter; }
  { const b = $('rfClear'); if (b) b.onclick = clearResearchFilter; }
  { const b = $('oppClose'); if (b) b.onclick = () => $('oppOverlay').classList.add('hidden'); }
  { const o = $('oppOverlay'); if (o) o.onclick = e => { if (e.target === o) o.classList.add('hidden'); }; }
  { const b = $('p2BatchBtn'); if (b) b.onclick = () => { if (!confirm('Pre-analizar el top 500 de categorías (por cuota x seller). Toma ~1–2 h en segundo plano y respeta el límite de ProfitGuard. Podés seguir usando la app. ¿Continuar?')) return; const force = confirm('¿Sobrescribir las que YA tenías analizadas, para aplicarles el contexto de negocio actual?\n\n• Aceptar = re-analiza TODAS (aplica el nuevo contexto).\n• Cancelar = solo las que falten.'); runP2Batch(500, force); }; }
  { const s = $('p2BatchStop'); if (s) s.onclick = () => { if (_p2Batch) _p2Batch.stop = true; s.classList.add('hidden'); const t = $('p2BatchTxt'); if (t && _p2Batch && _p2Batch.running) t.innerHTML += ' · <b>deteniendo…</b>'; }; }
  // Modal "Analizar en profundidad"
  { const c = $('p2DeepClose'); if (c) c.onclick = () => $('p2DeepOverlay').classList.add('hidden'); }
  { const o = $('p2DeepOverlay'); if (o) o.onclick = e => { if (e.target === o) o.classList.add('hidden'); }; }
  { const fi = $('p2DeepFile'); if (fi) fi.onchange = () => { const n = (fi.files[0] && fi.files[0].name) || ''; const m = n.match(/(20\d\d)-(\d\d)/); if (m) { $('p2DeepYear').value = m[1]; $('p2DeepMonth').value = String(+m[2]); } }; }
  { const im = $('p2DeepImport'); if (im) im.onclick = runP2DeepImport; }
  // Modal "Contexto IA"
  { const b = $('p2CtxBtn'); if (b) b.onclick = openP2CtxModal; }
  { const c = $('p2CtxClose'); if (c) c.onclick = () => $('p2CtxOverlay').classList.add('hidden'); }
  { const o = $('p2CtxOverlay'); if (o) o.onclick = e => { if (e.target === o) o.classList.add('hidden'); }; }
  { const s = $('p2CtxSave'); if (s) s.onclick = saveP2Ctx; }
  { const r = $('p2CtxReset'); if (r) r.onclick = () => { $('p2CtxText').value = P2_BIZ_DEFAULT; }; }
  // Reporte de detalle de categoría (Investigación)
  document.querySelectorAll('.rd-mbtn').forEach(b => b.onclick = () => { _rdMetric = b.dataset.metric; document.querySelectorAll('.rd-mbtn').forEach(x => x.classList.toggle('active', x === b)); renderRdChart(); });
  $('rdFrom').addEventListener('change', renderRdChart);
  $('rdTo').addEventListener('change', renderRdChart);
  { const b = $('p2Btn'); if (b) b.onclick = () => runP2(_rdItem, false); }
  $('rdClose').onclick = () => $('rDetailOverlay').classList.add('hidden');
  $('rDetailOverlay').onclick = e => { if (e.target === $('rDetailOverlay')) $('rDetailOverlay').classList.add('hidden'); };
  $('btnCatExport').onclick = exportCatalogoCSV;
  $('btnCatSync').onclick = syncFromPG;
  $('btnCatImport').onclick = () => $('catFile').click();
  $('catFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importCatalogExcel(f); e.target.value = ''; });
  $('catFilter').addEventListener('input', debounce(paintCatalogo, 200));

  $('btnAdd').onclick = addToComparison;
  $('btnNew').onclick = nuevoProducto;
  $('btnExport').onclick = exportCSV;
  $('btnClear').onclick = () => { viewList = []; renderHist(); };   // solo limpia la vista; el Excel queda intacto

  buildCatOptions('ml', '');
  buildCatOptions('fbla', '');
  bindCfg();
  applyCountryUI();     // pinta el país activo (bandera, Falabella oculta en CO, etiquetas de moneda)
  loadView();
  recompute();

  // Trae los parámetros compartidos del equipo y, si existen, sobreescriben los locales.
  (async () => {
    if (await settingsLoad()) {
      $('cfgFactorCBM').value = cfg.factorCBM;
      $('cfgDolar').value = cfg.dolar;
      $('cfgIva').value = cfg.iva;
      $('cfgRep').value = String(cfg.fblaRepIndex);
      recompute(); renderHist();
      if (!$('tabHist').classList.contains('hidden')) renderHistorial();
    }
    _setSig = JSON.stringify(SHARED_KEYS.map(k => cfg[k]));
  })();

  // Sincronización en vivo: cada 15 s y al volver a la pestaña/ventana.
  setInterval(liveTick, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); });
  window.addEventListener('focus', liveTick);
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); }; }

document.addEventListener('DOMContentLoaded', init);
