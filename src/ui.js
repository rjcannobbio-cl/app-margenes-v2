/* ============================================================
   Interfaz — wiring del DOM, selección de categorías y comparación
   ============================================================ */
'use strict';

// País activo (Chile por defecto). Cada país tiene sus propios parámetros y base de datos.
let country = localStorage.getItem('mp_country') || 'cl';
const cfg = loadCfg(country);
const state = { mlCatIdx: -1, fblaCatIdx: -1, lastResult: null, arancelPct: 0, hs: '' };

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
  buildCatOptions('ml', '');
  buildCatOptions('fbla', '');
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
}

async function addToComparison() {
  const r = state.lastResult;
  if (!r || (!r.ml.valid && !r.fbla.valid)) { alert('Ingresa al menos un precio de venta primero.'); return; }
  const proveedor = $('inpProveedor').value.trim();
  if (!proveedor) { alert('El proveedor es obligatorio.'); $('inpProveedor').focus(); return; }
  const editing = state.editingId || null;
  // Preserva Precio Full / DOD (se editan en el Historial) al re-guardar desde la Calculadora.
  const prev = editing ? ((_histAll || []).find(v => v.id === editing) || viewList.find(v => v.id === editing) || {}) : {};
  const item = {
    id: editing || newId(), ts: Date.now(),
    precioFull: (prev.precioFull != null ? prev.precioFull : ''), precioDOD: (prev.precioDOD != null ? prev.precioDOD : ''),
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
  };
  await histAdd(item);     // upsert en la base de datos (KV)
  const vi = viewList.findIndex(v => v.id === item.id);
  if (vi >= 0) viewList[vi] = item; else viewList.push(item);   // y en la vista
  renderHist();
  setEditing(item.id);     // sigue en edición de este registro
  setAiStatus(editing ? '✓ Cambios guardados.' : '✓ Producto guardado.', false);
  if (!$('tabHist').classList.contains('hidden')) renderHistorial();
}

function resolveCatIdx(idx, name, list) {
  if (idx != null && idx >= 0 && list[idx] && list[idx].name === name) return idx;
  if (name) { for (let i = 0; i < list.length; i++) if (list[i].name === name) return i; }
  return (idx != null && idx >= 0) ? idx : -1;
}

// Click en una fila → recarga ese producto al formulario y recalcula el detalle
function loadFromHist(x) {
  if (!x) return;
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
    badge.textContent = 'Editando un producto guardado — los cambios actualizan ese registro.';
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
  state.mlCatIdx = -1; state.fblaCatIdx = -1; state.arancelPct = 0; state.hs = '';
  if ($('hsBadge')) { $('hsBadge').textContent = 'sin deducir'; $('hsBadge').className = 'badge badge-warn'; }
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
function updateHistRow(tr, item) {
  const set = (key, v) => { const td = tr.querySelector(`[data-hcell="${key}"]`); if (!td) return; td.textContent = v == null ? '–' : fmtPct(v); td.className = 'mcell ' + (v == null ? '' : marginClass(v)); };
  set('full', histMlMarginPct(item, item.precioFull));
  set('dod', histMlMarginPct(item, item.precioDOD));
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
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'hist') renderHistorial();
  if (name === 'cat') renderCatalogo();
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
function paintHistorial() {
  const all = _histAll;
  // filtro por producto / SKU / proveedor / cotización
  const q = normalize(($('histFilter') && $('histFilter').value) || '');
  const filtered = q
    ? all.filter(x => normalize([x.nombre, x.skuProveedor, x.proveedor, x.cotizacion].join(' ')).includes(q))
    : all;
  $('histCount').textContent = (q ? (filtered.length + '/' + all.length) : all.length) +
    ' producto' + ((q ? filtered.length : all.length) === 1 ? '' : 's') + (_histBackend ? ' · compartido' : ' · solo local');
  const wrap = $('histDbWrap');
  if (!all.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Aún no hay productos evaluados. Agrégalos desde la pestaña Calculadora.</p>'; return; }
  if (!filtered.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Sin resultados para “' + escapeHtml($('histFilter').value) + '”.</p>'; return; }
  const cell = v => (v || v === 0) ? v : '';
  const hprice = (x, field) => `<td><input type="number" class="hist-price" data-id="${x.id || ''}" data-field="${field}" value="${x[field] || ''}" placeholder="–" min="0" step="1"></td>`;
  const hmarg = (key, v) => `<td class="mcell ${v == null ? '' : marginClass(v)}" data-hcell="${key}">${v == null ? '–' : fmtPct(v)}</td>`;

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
      ${hprice(x, 'precioDOD')}${hmarg('dod', histMlMarginPct(x, x.precioDOD))}
      <td><button class="mini" data-del="${x.id || ''}" title="Eliminar del historial">✕</button></td>
    </tr>`; }).join('');
  wrap.innerHTML = `<table class="histtab dbtab"><thead><tr>
    <th>ID</th><th>Nombre producto</th><th>Proveedor</th><th>N° Cotización</th>
    ${packHead}<th>Costo FOB</th><th>Landed COGS</th>
    <th>Súper</th><th>Categoría ML</th><th class="co-only">HS</th><th class="co-only">Arancel %</th><th>Precio Meli</th><th>Margen Meli</th><th class="fbla-col">Precio Fala</th><th class="fbla-col">Margen Fala</th>
    <th>Precio Full</th><th>Margen Full</th><th>Precio DOD</th><th>Margen DOD</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;

  const toggle = wrap.querySelector('.pack-toggle');
  if (toggle) toggle.onclick = (e) => { e.stopPropagation(); packExpanded = !packExpanded; renderHistorial(); };
  wrap.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('button') || e.target.closest('.pack-toggle') || e.target.closest('input')) return;
    showTab('calc'); loadFromHist(filtered[parseInt(tr.dataset.i, 10)]);
  });
  // Precio Full / DOD editables → recalculan su margen (Meli) y persisten en la base del país.
  wrap.querySelectorAll('input.hist-price').forEach(inp => inp.addEventListener('input', () => {
    const item = _histAll.find(x => x.id === inp.dataset.id);
    if (!item) return;
    item[inp.dataset.field] = inp.value === '' ? '' : (parseFloat(inp.value) || 0);
    updateHistRow(inp.closest('tr'), item);
    histSaveDebounced(item);
  }));
  // HS (texto) → solo persiste. Arancel % → recalcula todo (afecta el COGS) y persiste.
  wrap.querySelectorAll('input.hist-hs').forEach(inp => inp.addEventListener('change', () => {
    const item = _histAll.find(x => x.id === inp.dataset.id); if (!item) return;
    item.hs = inp.value.trim(); histSaveDebounced(item);
  }));
  wrap.querySelectorAll('input.hist-ar').forEach(inp => inp.addEventListener('change', () => {
    const item = _histAll.find(x => x.id === inp.dataset.id); if (!item) return;
    item.arancelPct = inp.value === '' ? '' : (parseFloat(inp.value) || 0);
    histSaveDebounced(item); paintHistorial();   // el arancel cambia el COGS y los márgenes
  }));
  wrap.querySelectorAll('button[data-del]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿Eliminar este producto del historial' + (_histBackend ? ' (para todo el equipo)' : '') + '?')) return;
    await histDel(b.dataset.del); renderHistorial();
  });
}

function exportHistorialCSV() {
  const h = _histAll;
  if (!h.length) { alert('No hay productos en el historial.'); return; }
  const head = ['ID', 'Nombre', 'Proveedor', 'N° Cotización', 'Alto', 'Largo', 'Ancho', 'Peso', 'Costo FOB', 'HS', 'Arancel %', 'Landed COGS', 'Supermercado', 'Categoría ML', 'Precio Meli', 'Margen Meli %', 'Precio Fala', 'Margen Fala %', 'Precio Full', 'Margen Full %', 'Precio DOD', 'Margen DOD %'];
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
      (x.precioFull || ''), p(histMlMarginPct(x, x.precioFull)), (x.precioDOD || ''), p(histMlMarginPct(x, x.precioDOD))
    ].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'historial_productos.csv'; a.click();
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

// Sincroniza FOB / proveedor / puerto desde ProfitGuard (server-side, key secreta).
async function syncFromPG() {
  if (!confirm('Sincronizar el catálogo con ProfitGuard (FOB, proveedor, puerto)?\nSe conservan las dimensiones y precios cargados desde el Excel.')) return;
  setCatStatus('Sincronizando con ProfitGuard…');
  try {
    const r = await fetch(api('/api/pg-sync'), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setCatStatus('Error: ' + (j.error || r.status) + (j.detail ? ' — ' + j.detail : ''), true); return; }
    setCatStatus(`✓ ${j.items} filas desde ${j.sourcings} sourcings de PG. Ahora importa el Excel para dims y precios.`);
    await renderCatalogo();
  } catch (e) { setCatStatus('Error de red al sincronizar: ' + e.message, true); }
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
    <tr data-id="${x.id}">
      <td>${escapeHtml(x.sku || '')}</td>
      <td title="${escapeHtml(x.titulo || '')}" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(x.titulo || '')}</td>
      <td>${cell(x.largo)}</td><td>${cell(x.alto)}</td><td>${cell(x.ancho)}</td><td>${cell(x.peso)}</td>
      <td>${x.fob ? ('US$' + x.fob) : ''}</td>
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${escapeHtml(x.puerto || '')}</td>
      <td class="co-only"><input type="text" class="cat-hs" data-id="${x.id}" value="${escapeHtml(x.hs || '')}" placeholder="–" style="width:88px"></td>
      <td class="co-only"><input type="number" class="cat-ar" data-id="${x.id}" value="${(x.arancelPct || x.arancelPct === 0) ? x.arancelPct : ''}" placeholder="0" min="0" step="0.1" style="width:60px"></td>
      <td class="mcell" data-cell="cogs">${fmtCLP(r.cogs)}</td>
      ${priceInput(x, 'precioFull')}${mc('full-ml', r.full.ml)}${mc('full-fa', r.full.fa)}
      ${priceInput(x, 'precioAON')}${mc('aon-ml', r.aon.ml)}${mc('aon-fa', r.aon.fa)}
      ${priceInput(x, 'precioDOD')}${mc('dod-ml', r.dod.ml)}${mc('dod-fa', r.dod.fa)}
    </tr>`; }).join('');
  wrap.innerHTML = `<table class="histtab dbtab" style="min-width:1700px"><thead><tr>
    <th>SKU</th><th>Título</th><th>Largo</th><th>Alto</th><th>Ancho</th><th>Peso</th><th>Precio FOB</th><th>Proveedor</th><th>Puerto</th><th class="co-only">HS</th><th class="co-only">Arancel %</th><th>Landed COGS</th>
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
  _setSig = ''; _histSig = ''; _catSig = '';
  applyCountryUI();
  bindCfgValues();
  nuevoProducto();                           // limpia el formulario
  loadView();                                // recarga la comparación del país
  if (!$('tabHist').classList.contains('hidden')) renderHistorial();
  if (!$('tabCat').classList.contains('hidden')) renderCatalogo();
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

  // selects de categoría (la categoría sugerida por IA queda seleccionada; se puede cambiar a mano)
  $('mlCatSelect').addEventListener('change', () => { state.mlCatIdx = parseInt($('mlCatSelect').value, 10); recompute(); });
  $('fblaCatSelect').addEventListener('change', () => { state.fblaCatIdx = parseInt($('fblaCatSelect').value, 10); recompute(); });

  // selector de país (banderas)
  document.querySelectorAll('.flag-btn').forEach(b => b.onclick = () => switchCountry(b.dataset.country));

  // pestañas + historial
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
  $('btnHistRefresh').onclick = renderHistorial;
  $('btnHistExport').onclick = exportHistorialCSV;
  $('histFilter').addEventListener('input', debounce(renderHistorial, 200));
  $('btnCatRefresh').onclick = renderCatalogo;
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
