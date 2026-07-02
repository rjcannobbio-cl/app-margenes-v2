/* ============================================================
   Calculadora de márgenes — productos en evaluación (ML / Falabella)
   Lógica de cálculo, deducción de categoría y render.
   ============================================================ */

'use strict';

/* ---------------- Configuración (parámetros editables) ---------------- */
const VOL_DIVISOR = 4000;     // peso volumétrico = largo*ancho*alto/4000 (fijo, no editable)

const DEFAULT_CFG = {
  priceTier1: 9990,           // límite tramo 1/2 de precio (col t1 vs t2 en ML)
  priceTier2: 19990,          // límite tramo 2/3 de precio (ML) y <$19.990 vs ≥$19.990 (Falabella)
  fblaRepIndex: 0,            // 0=5/5  1=4/5  2=3/5  3=2/5
  factorCBM: 110,             // factor CBM = precio de contenedor en USD/m³ (input, celda X4; varía por cotización)
  iva: 19,                    // % IVA aplicado al landed cost
  dolar: 900,                 // CLP por USD (último valor usado, editable como input)
  apiKey: '',                 // API key del proveedor de IA (solo en este navegador)
  aiProvider: 'gemini',       // 'gemini' | 'anthropic' (nube, con key) | 'local' (experimental, baja precisión)
  aiModel: ''                 // vacío → usa el default del proveedor
};

// Parámetros propios por país. Chile: clave 'mpcfg' (compatibilidad). Colombia: 'mpcfg_co'
// con dólar por defecto en COP. cfg.country identifica el país activo.
function loadCfg(country) {
  country = country || 'cl';
  const base = Object.assign({}, DEFAULT_CFG, country === 'co' ? { dolar: 4000 } : {}, { country });
  const lsKey = country === 'co' ? 'mpcfg_co' : 'mpcfg';
  try {
    const s = JSON.parse(localStorage.getItem(lsKey) || '{}');
    return Object.assign(base, s, { country });
  } catch (e) { return base; }
}
function saveCfg(cfg) {
  const lsKey = (cfg && cfg.country === 'co') ? 'mpcfg_co' : 'mpcfg';
  localStorage.setItem(lsKey, JSON.stringify(cfg));
}

/* ---------------- Utilidades ---------------- */
function normalize(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita acentos
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const STOPWORDS = new Set(['de','la','el','los','las','para','con','sin','por','set','kit','un','una','y','o','del','al','en','x','pack']);
function tokens(s) {
  return normalize(s).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
}
// Variantes de stem para tolerar plurales españoles: vocal+s (bebés→bebe) y consonante+es (sartenes→sarten).
// Se prueban todas; dos palabras "calzan" si comparten alguna variante.
function stemVariants(w) {
  const out = [w];
  if (w.length > 3 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s')) out.push(w.slice(0, -1));
  return out;
}
function fmtCLP(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  const r = Math.round(n);
  return '$' + r.toLocaleString('es-CL');
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  return n.toFixed(1) + '%';
}

/* ---------------- Deducción de categoría ---------------- */
// Devuelve {index, score} de la mejor categoría para el texto dado.
function deduceCategory(text, list, nameKey) {
  const tToks = tokens(text);
  if (!tToks.length) return { index: -1, score: 0 };
  const tVars = tToks.map(stemVariants);                 // variantes por token del título
  const tSet = new Set();
  tVars.forEach(vs => vs.forEach(v => tSet.add(v)));
  // término principal del título (primer token significativo = tipo de producto, normalmente)
  const headSet = new Set(stemVariants(tToks[0]));
  const normText = normalize(text);
  let best = -1, bestScore = 0, bestLen = Infinity;
  for (let i = 0; i < list.length; i++) {
    const name = list[i][nameKey];
    const cToks = tokens(name);
    if (!cToks.length) continue;
    // --- coincidencia con la HOJA (tipo de producto) ---
    let matchCount = 0, headHit = false;
    const leafSet = new Set();
    for (const ct of cToks) {
      const vs = stemVariants(ct);
      vs.forEach(v => leafSet.add(v));
      if (vs.some(v => tSet.has(v))) matchCount++;
      if (vs.some(v => headSet.has(v))) headHit = true;
    }
    if (!matchCount) continue;
    // --- coincidencia con la RAMA / L1 (contexto: deporte, gimnasio, cocina, etc.) ---
    let contextHits = 0;
    const path = list[i].path || '';
    const cut = path.lastIndexOf(' > ');
    if (cut >= 0) {
      const l1Set = new Set();
      for (const ct of tokens(path.slice(0, cut))) stemVariants(ct).forEach(v => l1Set.add(v));
      for (let k = 1; k < tToks.length; k++) {           // tokens de contexto (excluye el head)
        const vs = tVars[k];
        if (!vs.some(v => leafSet.has(v)) && vs.some(v => l1Set.has(v))) contextHits++;
      }
    }
    const normName = normalize(name);
    // bonus solo para nombres multi-palabra presentes completos (señal específica; evita que una hoja
    // de una sola palabra que aparece como contexto, ej. "Cocina", se lleve el bonus)
    const nameBonus = (cToks.length >= 2 && normName && normText.includes(normName)) ? 3 : 0;
    const ratio = matchCount / cToks.length;                              // especificidad de la hoja
    const headBonus = headHit ? 2 : 0;                                    // matchea el sustantivo principal
    const contextBonus = contextHits * 0.8;                               // el contexto desempata la rama/L1
    const finalScore = matchCount + ratio + nameBonus + headBonus + contextBonus;
    if (finalScore > bestScore || (finalScore === bestScore && name.length < bestLen)) {
      bestScore = finalScore; best = i; bestLen = name.length;
    }
  }
  return { index: best, score: bestScore };
}

/* ---------------- Landed cost (COGS) ---------------- */
// Replica la planilla de costeo: (FOB + CBM_unidad*factorCBM) * dólar * (1 + IVA)
// cbmUnit (m³) se deriva de las dimensiones; factorCBM es el precio de contenedor (USD/m³).
function computeLanded(fobUsd, cbmUnit, factorCBM, dolar, cfg, arancelPct) {
  const base = ((fobUsd || 0) + (cbmUnit || 0) * (factorCBM || 0)) * dolar;
  // Colombia: arancel por producto (según código HS). Chile: 0% por el TLC con China → factor 1.
  const ar = (cfg && cfg.country === 'co') ? (1 + (parseFloat(arancelPct) || 0) / 100) : 1;
  return base * ar * (1 + (cfg.iva || 0) / 100);
}

/* ---------------- Peso facturable ---------------- */
function volumetricKg(alto, ancho, largo, divisor) {
  if (!alto || !ancho || !largo || !divisor) return 0;
  return (alto * ancho * largo) / divisor;
}
function billableWeight(pesoFisico, alto, ancho, largo, divisor) {
  const vol = volumetricKg(alto, ancho, largo, divisor);
  return Math.max(pesoFisico || 0, vol);
}

/* ---------------- Costo de envío ---------------- */
// Mercado Libre COLOMBIA — costo de envío desde la tabla 2D (peso × precio), en COP.
function mlShippingCO(price, weight) {
  const out = { cost: 0, note: '', warn: '' };
  const t = ML_SHIP_CO;
  let row = t.rows.find(r => weight <= r.maxKg);
  if (!row) { row = t.rows[t.rows.length - 1]; out.warn = 'Peso > 90 kg: fuera de la tabla, se usó el último tramo.'; }
  let pi = t.priceBreaks.findIndex(b => price <= b);
  if (pi < 0) pi = t.priceBreaks.length;              // ≥ $60.000 → última columna
  out.cost = row.cols[pi];
  return out;
}

function mlShipping(price, weight, isSuper, cfg) {
  if (cfg && cfg.country === 'co') return mlShippingCO(price, weight);
  const out = { cost: 0, note: '', warn: '' };
  if (isSuper) {
    if (price >= cfg.priceTier2) {
      // La tabla super solo cubre hasta $19.990 → fallback a tarifa normal ≥$19.990
      const row = ML_SHIP_NORMAL.find(r => weight <= r.maxKg) || ML_SHIP_NORMAL[ML_SHIP_NORMAL.length - 1];
      out.cost = row.t3;
      out.note = 'Super ≥ $19.990: se cobra como producto normal.';
      return out;
    }
    const t = ML_SHIP_SUPER;
    const row = t.rows.find(r => weight <= r.maxKg) || t.rows[t.rows.length - 1];
    let pi = t.priceBreaks.findIndex(b => price <= b);
    if (pi < 0) pi = t.priceBreaks.length - 1;
    let cost = row.cols[pi];
    const cap = 0.25 * price;          // nunca supera el 25% del precio
    if (cost > cap) { cost = cap; out.note = 'Topado al 25% del precio'; }
    out.cost = cost;
    return out;
  }
  // Producto normal — ML siempre cobra envío, según el tramo de precio
  let row = ML_SHIP_NORMAL.find(r => weight <= r.maxKg);
  if (!row) {
    row = ML_SHIP_NORMAL[ML_SHIP_NORMAL.length - 1];
    out.warn = 'Peso > 110 kg: fuera de la tabla cargada, se usó el último tramo.';
  }
  if (price < cfg.priceTier1) out.cost = row.t1;             // ≤ $9.989
  else if (price < cfg.priceTier2) out.cost = row.t2;        // $9.990 – $19.989
  else out.cost = row.t3;                                    // ≥ $19.990
  return out;
}

function fblaShipping(price, weight, cfg) {
  const out = { cost: 0, note: '', warn: '' };
  const repIndex = cfg.fblaRepIndex || 0;
  const row = FBLA_SHIP.find(r => weight <= r.maxKg) || FBLA_SHIP[FBLA_SHIP.length - 1];
  const arr = price < cfg.priceTier2 ? row.menor : row.mayor;
  let cost = arr[repIndex];
  if (row.perKg) { cost = cost * weight; out.warn = 'Peso > 600 kg: tarifa por kg.'; }
  out.cost = cost;
  return out;
}

/* ---------------- Cálculo por canal ---------------- */
// channel: 'ml' | 'fbla'
function computeChannel(channel, price, cost, comPct, weight, isSuper, cfg) {
  const r = { channel, price, valid: price > 0 };
  r.cogs = cost;
  r.cogsPct = price > 0 ? (cost / price) * 100 : 0;

  r.comPct = comPct;                       // % comisión de la categoría
  r.com = price * (comPct / 100);
  r.comPctOfPrice = comPct;

  let ship;
  if (channel === 'ml') {
    ship = mlShipping(price, weight, isSuper, cfg);
  } else {
    ship = fblaShipping(price, weight, cfg);
  }
  r.ship = ship.cost;
  r.shipPct = price > 0 ? (ship.cost / price) * 100 : 0;
  r.shipNote = ship.note;
  r.shipWarn = ship.warn;

  r.margin = price - r.cogs - r.com - r.ship;
  r.marginPct = price > 0 ? (r.margin / price) * 100 : 0;
  return r;
}
