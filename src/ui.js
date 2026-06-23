/* ============================================================
   Interfaz — wiring del DOM, selección de categorías y comparación
   ============================================================ */
'use strict';

const cfg = loadCfg();
const state = { mlCatIdx: -1, fblaCatIdx: -1, lastResult: null };

const $ = (id) => document.getElementById(id);
const num = (id) => { const v = parseFloat($(id).value.replace(',', '.')); return isNaN(v) ? 0 : v; };

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

/* ---------------- Cálculo y render ---------------- */
function recompute() {
  const alto = num('inpAlto'), ancho = num('inpAncho'), largo = num('inpLargo');
  const peso = num('inpPeso');
  const cbmUnit = (alto * ancho * largo) / 1000000;    // volumen por unidad (m³) desde dimensiones
  const fob = num('inpFob'), factorCBM = cfg.factorCBM, dolar = cfg.dolar;   // factor CBM y dólar viven en Parámetros
  const costo = computeLanded(fob, cbmUnit, factorCBM, dolar, cfg);   // landed cost = COGS
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
      const r = await fetch('/api/products');
      if (r.ok) { _histBackend = true; return await r.json(); }
      _histBackend = false;
    } catch (e) { _histBackend = false; }
  }
  return localLoad();
}
async function histAdd(item) {
  if (_histBackend) {
    try { const r = await fetch('/api/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) }); if (r.ok) return; } catch (e) {}
  }
  const h = localLoad(); const i = h.findIndex(x => x.id === item.id);
  if (i >= 0) h[i] = item; else h.push(item);   // upsert por id
  localSave(h);
}
async function histDel(id) {
  if (_histBackend) {
    try { const r = await fetch('/api/products?id=' + encodeURIComponent(id), { method: 'DELETE' }); if (r.ok) return; } catch (e) {}
  }
  localSave(localLoad().filter(x => x.id !== id));
}
async function histClear() {
  if (_histBackend) {
    try { const r = await fetch('/api/products?all=1', { method: 'DELETE' }); if (r.ok) return; } catch (e) {}
  }
  localSave([]);
}
function newId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(16).slice(2)); }

async function addToComparison() {
  const r = state.lastResult;
  if (!r || (!r.ml.valid && !r.fbla.valid)) { alert('Ingresa al menos un precio de venta primero.'); return; }
  const proveedor = $('inpProveedor').value.trim();
  if (!proveedor) { alert('El proveedor es obligatorio.'); $('inpProveedor').focus(); return; }
  const editing = state.editingId || null;
  const item = {
    id: editing || newId(), ts: Date.now(),
    fecha: new Date().toISOString().slice(0, 19).replace('T', ' '),
    nombre: r.nombre || '(sin nombre)', proveedor: proveedor, cotizacion: $('inpCotizacion').value.trim(), skuProveedor: $('inpSkuProv').value.trim(),
    alto: num('inpAlto'), ancho: num('inpAncho'), largo: num('inpLargo'), peso: num('inpPeso'), fob: num('inpFob'),
    precioML: num('inpPrecioML'), precioFB: num('inpPrecioFB'), isSuper: $('inpSuper').checked,
    mlCatIdx: state.mlCatIdx, mlCatName: r.ml.catName, mlComPct: r.ml.comPct,
    fblaCatIdx: state.fblaCatIdx, fblaCatName: r.fbla.catName, fbComPct: r.fbla.comPct,
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
  ['inpNombre', 'inpProveedor', 'inpCotizacion', 'inpSkuProv', 'inpAlto', 'inpAncho', 'inpLargo', 'inpPeso', 'inpFob', 'inpPrecioML', 'inpPrecioFB'].forEach(id => $(id).value = '');
  $('inpSuper').checked = false;
  state.mlCatIdx = -1; state.fblaCatIdx = -1;
  refreshCatUI();
  markDeduced('ml', false); markDeduced('fbla', false);
  setEditing(null);
  setAiStatus('', false);
  recompute();
  $('inpNombre').focus();
}

function renderHist() {
  const h = viewList;
  const wrap = $('histWrap');
  if (!h.length) { wrap.innerHTML = '<p class="muted">Aún no agregas productos a la comparación.</p>'; return; }
  const rows = h.map((x, i) => `
    <tr data-i="${i}" title="Clic para cargar este producto">
      <td>${escapeHtml(x.nombre)}</td>
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${fmtCLP(x.cogs)}</td>
      <td>${fmtCLP(x.mlPrice)}</td>
      <td class="${marginClass(x.mlMarginPct)}">${fmtCLP(x.mlMargin)} · ${fmtPct(x.mlMarginPct)}</td>
      <td>${fmtCLP(x.fbPrice)}</td>
      <td class="${marginClass(x.fbMarginPct)}">${fmtCLP(x.fbMargin)} · ${fmtPct(x.fbMarginPct)}</td>
      <td><button class="mini" data-del="${x.id || ''}" title="Quitar">✕</button></td>
    </tr>`).join('');
  wrap.innerHTML = `<table class="histtab">
    <thead><tr><th>Producto</th><th>Proveedor</th><th>COGS</th><th>Precio ML</th><th>Margen ML</th><th>Precio Fala</th><th>Margen Fala</th><th></th></tr></thead>
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
    lines.push([
      q(x.nombre), q(x.proveedor), q(x.cotizacion),
      Math.round(x.cogs), Math.round(x.mlPrice), Math.round(x.mlMargin), (x.mlMarginPct || 0).toFixed(1).replace('.', ','),
      Math.round(x.fbPrice), Math.round(x.fbMargin), (x.fbMarginPct || 0).toFixed(1).replace('.', ',')
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
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'hist') renderHistorial();
}

function compositeId(x) {
  return [x.nombre, x.proveedor, x.cotizacion, x.skuProveedor]
    .map(s => (s == null ? '' : s).toString().trim()).filter(Boolean).join(' · ');
}

let _histAll = [];
async function renderHistorial() {
  const all = await histLoad();
  _histAll = all;
  $('histCount').textContent = all.length + (all.length === 1 ? ' producto' : ' productos') + (_histBackend ? ' · compartido' : ' · solo local');
  const wrap = $('histDbWrap');
  if (!all.length) { wrap.innerHTML = '<p class="muted" style="padding:16px">Aún no hay productos evaluados. Agrégalos desde la pestaña Calculadora.</p>'; return; }
  const cell = v => (v || v === 0) ? v : '';
  const rows = all.map((x, i) => `
    <tr data-i="${i}" title="Clic para cargar este producto en la calculadora">
      <td>${escapeHtml(compositeId(x))}</td>
      <td>${escapeHtml(x.nombre || '')}</td>
      <td>${escapeHtml(x.proveedor || '')}</td>
      <td>${escapeHtml(x.cotizacion || '')}</td>
      <td>${cell(x.alto)}</td><td>${cell(x.largo)}</td><td>${cell(x.ancho)}</td><td>${cell(x.peso)}</td>
      <td>${x.fob ? ('US$' + x.fob) : ''}</td>
      <td>${fmtCLP(x.cogs)}</td>
      <td>${x.isSuper ? 'Sí' : 'No'}</td>
      <td>${escapeHtml(x.mlCatName || '')}</td>
      <td>${fmtCLP(x.mlPrice)}</td>
      <td class="${marginClass(x.mlMarginPct)}">${fmtPct(x.mlMarginPct)}</td>
      <td>${fmtCLP(x.fbPrice)}</td>
      <td class="${marginClass(x.fbMarginPct)}">${fmtPct(x.fbMarginPct)}</td>
      <td><button class="mini" data-del="${x.id || ''}" title="Eliminar del historial">✕</button></td>
    </tr>`).join('');
  wrap.innerHTML = `<table class="histtab dbtab"><thead><tr>
    <th>ID</th><th>Nombre producto</th><th>Proveedor</th><th>N° Cotización</th>
    <th>Alto</th><th>Largo</th><th>Ancho</th><th>Peso</th><th>Costo FOB</th><th>Landed COGS</th>
    <th>Súper</th><th>Categoría ML</th><th>Precio Meli</th><th>Margen Meli</th><th>Precio Fala</th><th>Margen Fala</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('button')) return;
    showTab('calc'); loadFromHist(all[parseInt(tr.dataset.i, 10)]);
  });
  wrap.querySelectorAll('button[data-del]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿Eliminar este producto del historial' + (_histBackend ? ' (para todo el equipo)' : '') + '?')) return;
    await histDel(b.dataset.del); renderHistorial();
  });
}

function exportHistorialCSV() {
  const h = _histAll;
  if (!h.length) { alert('No hay productos en el historial.'); return; }
  const head = ['ID', 'Nombre', 'Proveedor', 'N° Cotización', 'Alto', 'Largo', 'Ancho', 'Peso', 'Costo FOB', 'Landed COGS', 'Supermercado', 'Categoría ML', 'Precio Meli', 'Margen Meli %', 'Precio Fala', 'Margen Fala %'];
  const q = s => '"' + (s == null ? '' : s).toString().replace(/"/g, '""') + '"';
  const n = v => (v == null || isNaN(v)) ? '' : Math.round(v);
  const p = v => (v == null || isNaN(v)) ? '' : Number(v).toFixed(1).replace('.', ',');
  const lines = [head.join(';')];
  for (const x of h) lines.push([
    q(compositeId(x)), q(x.nombre), q(x.proveedor), q(x.cotizacion),
    (x.alto || ''), (x.largo || ''), (x.ancho || ''), (x.peso || ''), (x.fob || ''), n(x.cogs),
    x.isSuper ? 'Sí' : 'No', q(x.mlCatName), n(x.mlPrice), p(x.mlMarginPct), n(x.fbPrice), p(x.fbMarginPct)
  ].join(';'));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'historial_productos.csv'; a.click();
}

/* ---------------- Panel de parámetros ---------------- */
function bindCfg() {
  $('cfgRep').value = String(cfg.fblaRepIndex);
  $('cfgIva').value = cfg.iva;
  $('cfgApiKey').value = cfg.apiKey || '';
  $('cfgFactorCBM').value = cfg.factorCBM;
  $('cfgDolar').value = cfg.dolar;
  $('btnSaveCfg').onclick = () => {
    cfg.fblaRepIndex = parseInt($('cfgRep').value, 10) || 0;
    cfg.iva = parseFloat($('cfgIva').value) || 0;
    cfg.apiKey = $('cfgApiKey').value.trim();
    cfg.factorCBM = parseFloat($('cfgFactorCBM').value) || 0;
    cfg.dolar = parseFloat($('cfgDolar').value) || 0;
    saveCfg(cfg); recompute();
    $('cfgSaved').textContent = '✓ guardado'; setTimeout(() => $('cfgSaved').textContent = '', 1500);
  };
  $('cfgToggle').onclick = () => $('cfgBody').classList.toggle('hidden');
}

/* ---------------- Init ---------------- */
function init() {
  // recompute en cualquier cambio de input numérico
  ['inpAlto','inpAncho','inpLargo','inpPeso','inpFob','inpPrecioML','inpPrecioFB'].forEach(id => $(id).addEventListener('input', recompute));
  $('inpSuper').addEventListener('change', recompute);

  // deducción 3 s después de que el usuario deja de escribir (la IA tarda y consume cuota)
  $('inpNombre').addEventListener('input', debounce(autoDeduce, 3000));
  $('btnAI').addEventListener('click', () => { if (!deduceText()) { setAiStatus('Escribe primero el nombre del producto.', true); return; } autoDeduce(); });

  // selects de categoría (la categoría sugerida por IA queda seleccionada; se puede cambiar a mano)
  $('mlCatSelect').addEventListener('change', () => { state.mlCatIdx = parseInt($('mlCatSelect').value, 10); recompute(); });
  $('fblaCatSelect').addEventListener('change', () => { state.fblaCatIdx = parseInt($('fblaCatSelect').value, 10); recompute(); });

  // pestañas + historial
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
  $('btnHistRefresh').onclick = renderHistorial;
  $('btnHistExport').onclick = exportHistorialCSV;

  $('btnAdd').onclick = addToComparison;
  $('btnNew').onclick = nuevoProducto;
  $('btnExport').onclick = exportCSV;
  $('btnClear').onclick = () => { viewList = []; renderHist(); };   // solo limpia la vista; el Excel queda intacto

  buildCatOptions('ml', '');
  buildCatOptions('fbla', '');
  bindCfg();
  loadView();
  recompute();
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); }; }

document.addEventListener('DOMContentLoaded', init);
