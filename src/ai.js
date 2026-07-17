/* ============================================================
   Predicción de categoría con IA (Google Gemini / Anthropic)
   La IA lee el título completo (contexto + sinónimos) y devuelve JSON con
   L1 y Hoja para cada canal; luego se mapea a la categoría real (comisión).
   ============================================================ */
'use strict';

// Proveedor y modelo FIJOS (no configurables): Claude Haiku 4.5 vía API de Anthropic.
const AI_PROVIDER = 'anthropic';
const AI_MODEL = 'claude-haiku-4-5-20251001';
function aiProvider() { return AI_PROVIDER; }
function aiModel() { return AI_MODEL; }

// Router con 1 reintento ante 429 (límite de cuota/min).
async function aiText(prompt, cfg, opts) {
  opts = opts || {};
  const call = () => aiProvider(cfg) === 'anthropic' ? anthropicText(prompt, cfg, opts) : geminiText(prompt, cfg, opts);
  try { return await call(); }
  catch (e) {
    if (/\b429\b/.test(e.message || '')) { await new Promise(r => setTimeout(r, 2500)); return await call(); }
    throw e;
  }
}

// --- Google Gemini (capa gratuita) ---
async function geminiText(prompt, cfg, opts) {
  opts = opts || {};
  const gen = { temperature: 0, maxOutputTokens: opts.maxTokens || 1024 };
  // Gemini 2.5 "piensa" y consume tokens de salida; lo desactivamos (clasificación simple).
  if (/2\.5/.test(aiModel(cfg))) gen.thinkingConfig = { thinkingBudget: 0 };
  if (opts.schema) { gen.responseMimeType = 'application/json'; gen.responseSchema = opts.schema; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(aiModel(cfg)) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gen })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 160) : ''));
  }
  const d = await res.json();
  const c = d.candidates && d.candidates[0];
  return ((c && c.content && c.content.parts) || []).map(p => p.text || '').join('').trim();
}

// --- Anthropic (Claude) ---
// Con key pegada (dev local) → llamada directa. Sin key → proxy /api/anthropic
// (producción en Cloudflare: la key vive en el servidor, no en el navegador).
async function anthropicText(prompt, cfg, opts) {
  opts = opts || {};
  const content = (Array.isArray(opts.content) && opts.content.length) ? opts.content : prompt;   // visión: bloques texto+imagen
  let res;
  if (cfg.apiKey) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: aiModel(cfg),
        max_tokens: opts.maxTokens || 256,
        temperature: 0,
        messages: [{ role: 'user', content }]
      })
    });
  } else {
    res = await fetch('/api/anthropic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Array.isArray(opts.content) && opts.content.length ? { content: opts.content, maxTokens: opts.maxTokens || 256 } : { prompt: prompt, maxTokens: opts.maxTokens || 256 })
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 160) : ''));
  }
  const d = await res.json();
  return (d.content || []).map(b => b.text || '').join('').trim();
}

// --- Utilidades de mapeo ---
function listL1s(list) {
  const seen = new Set(), out = [];
  for (const c of list) {
    const s = (c.path || c.name).split(' > ')[0].trim();
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Mejor hoja dentro de un L1 que calce con el nombre propuesto por la IA.
// Devuelve -1 si NO hay coincidencia real (para no inventar una hoja al azar).
function matchLeafInL1(hoja, l1, list) {
  const hSet = new Set();
  for (const t of tokens(hoja)) stemVariants(t).forEach(v => hSet.add(v));
  const nh = normalize(hoja);
  let best = -1, bestScore = 0, bestLen = Infinity;
  for (let i = 0; i < list.length; i++) {
    if ((list[i].path || list[i].name).split(' > ')[0].trim() !== l1) continue;
    const name = list[i].name, nn = normalize(name);
    let score = 0;
    for (const ct of tokens(name)) if (stemVariants(ct).some(v => hSet.has(v))) score++;
    if (nn === nh) score += 10;
    else if (nh && (nn.includes(nh) || nh.includes(nn))) score += 3;
    if (score > bestScore || (score === bestScore && score > 0 && name.length < bestLen)) {
      bestScore = score; best = i; bestLen = name.length;
    }
  }
  return bestScore > 0 ? best : -1;   // sin coincidencia real → -1
}

function resolveL1(l1, l1s) {
  let r = l1s.find(x => normalize(x) === normalize(l1));
  if (!r && l1) {
    let bs = -1;
    for (const x of l1s) {
      const a = normalize(x); let s = 0;
      normalize(l1).split(' ').forEach(w => { if (w.length > 2 && a.includes(w)) s++; });
      if (s > bs) { bs = s; r = x; }
    }
  }
  return r || '';
}

// Mapea (L1, Hoja) propuestos a un índice real; -1 si no hay match confiable.
function resolveL1Hoja(l1, hoja, list, l1s) {
  const l1res = resolveL1(l1, l1s);
  if (!l1res) return -1;
  return matchLeafInL1(hoja || '', l1res, list);
}

function parseJSONLoose(s) {
  if (!s) return null;
  let t = s.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const b = t.indexOf('{'); if (b < 0) return null;
  t = t.slice(b);
  // 1) intento directo, recortando al último '}'
  const e = t.lastIndexOf('}');
  if (e > 0) { try { return JSON.parse(t.slice(0, e + 1)); } catch (_) {} }
  // 2) reparar JSON truncado (respuesta cortada por max_tokens): balancear y cerrar
  try { return JSON.parse(repairTruncatedJSON(t)); } catch (_) { return null; }
}
// Cierra strings/estructuras abiertas de un JSON cortado a la mitad para poder parsear lo que sí llegó.
function repairTruncatedJSON(t) {
  let inStr = false, esc = false; const stack = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = t;
  if (inStr) out += '"';                              // cierra un string cortado
  out = out.replace(/,\s*$/, '');                     // coma colgante
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '');       // clave sin valor al final
  out = out.replace(/:\s*$/, ': null');               // valor faltante
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];   // cierra { [ pendientes
  return out;
}

// Nombres de hoja (únicos) dentro de un L1
function leavesOfL1(list, l1) {
  const seen = new Set(), out = [];
  for (const c of list) {
    if ((c.path || c.name).split(' > ')[0].trim() === l1 && !seen.has(c.name)) {
      seen.add(c.name); out.push(c.name);
    }
  }
  return out;
}

// Índice global (en `list`) de una hoja exacta dentro de un L1; -1 si no está.
function leafIndexExact(name, l1, list) {
  const nn = normalize(name);
  for (let i = 0; i < list.length; i++) {
    if ((list[i].path || list[i].name).split(' > ')[0].trim() === l1 && normalize(list[i].name) === nn) return i;
  }
  return matchLeafInL1(name, l1, list);   // por si viene con pequeñas diferencias
}

// Predicción en DOS pasos. El schema usa ENUM, así Gemini está OBLIGADO a responder
// un valor EXACTO de las listas (no puede inventar "Straps"):
//   1) elige el L1 de cada canal (enum de L1 válidos)
//   2) elige la hoja de cada canal (enum de las hojas REALES de ese L1)
// Devuelve { ml: idx, fbla: idx, raw } (índices o -1 si no hay match).
async function aiSuggestBoth(title, cfg) {
  const mlL1 = listL1s(ML_CATEGORIES);
  const fbL1 = listL1s(FBLA_CATEGORIES);

  // --- Paso 1: elegir L1 (forzado por enum) ---
  const schema1 = {
    type: 'OBJECT',
    properties: { ml_l1: { type: 'STRING', enum: mlL1 }, fbla_l1: { type: 'STRING', enum: fbL1 } },
    required: ['ml_l1', 'fbla_l1']
  };
  const p1 =
    `Eres un clasificador experto de catálogos de marketplaces chilenos.\n` +
    `Interpreta el TÍTULO COMPLETO de este producto: "${title}".\n` +
    `Elige la categoría de primer nivel (L1) que mejor le corresponde en Mercado Libre y en Falabella. ` +
    `Piensa en para qué se usa el producto, no en una palabra suelta (ej. "straps para levantamiento de pesas" es de gimnasio/deporte, NO accesorio de auto).\n\n` +
    `L1 válidos de Mercado Libre: ${mlL1.join(' | ')}\n` +
    `L1 válidos de Falabella: ${fbL1.join(' | ')}\n\n` +
    `Responde SOLO este JSON: {"ml_l1":"<uno exacto de la lista ML>","fbla_l1":"<uno exacto de la lista Falabella>"}`;
  const o1 = parseJSONLoose(await aiText(p1, cfg, { schema: schema1, maxTokens: 256 })) || {};
  const mlL1res = resolveL1(o1.ml_l1, mlL1) || mlL1[0];
  const fbL1res = resolveL1(o1.fbla_l1, fbL1) || fbL1[0];

  // --- Paso 2: elegir la hoja por NÚMERO (la salida es un entero; sin enum gigante) ---
  const mlLeaves = leavesOfL1(ML_CATEGORIES, mlL1res);
  const fbLeaves = leavesOfL1(FBLA_CATEGORIES, fbL1res);
  const numbered = arr => arr.map((n, i) => (i + 1) + '. ' + n).join('\n');
  const schema2 = {
    type: 'OBJECT',
    properties: { ml_idx: { type: 'INTEGER' }, fbla_idx: { type: 'INTEGER' } },
    required: ['ml_idx', 'fbla_idx']
  };
  const p2 =
    `Producto que se quiere vender: "${title}".\n` +
    `Elige la subcategoría MÁS adecuada para este producto en cada marketplace y responde con su NÚMERO.\n` +
    `Considera sinónimos y el uso real del producto (ej. "straps" de gimnasio = "Correas para Levantamiento" o "Agarres para Gimnasio", NO accesorio de auto).\n\n` +
    `Mercado Libre — categoría "${mlL1res}":\n${numbered(mlLeaves)}\n\n` +
    `Falabella — categoría "${fbL1res}":\n${numbered(fbLeaves)}\n\n` +
    `Responde SOLO este JSON: {"ml_idx": <número de la lista de Mercado Libre>, "fbla_idx": <número de la lista de Falabella>}`;
  const o2 = parseJSONLoose(await aiText(p2, cfg, { schema: schema2, maxTokens: 256 })) || {};

  const pick = (idx, leaves) => {
    const n = parseInt(idx, 10);
    return (n >= 1 && n <= leaves.length) ? leaves[n - 1] : '';
  };
  const mlHoja = pick(o2.ml_idx, mlLeaves);
  const fbHoja = pick(o2.fbla_idx, fbLeaves);

  return {
    ml: leafIndexExact(mlHoja, mlL1res, ML_CATEGORIES),
    fbla: leafIndexExact(fbHoja, fbL1res, FBLA_CATEGORIES),
    raw: { mlL1res, fbL1res, ml_hoja: mlHoja, fbla_hoja: fbHoja }
  };
}

// Sugerencia de código HS (subpartida arancelaria) + arancel% para COLOMBIA.
// Estimación para simular margen (NO es clasificación aduanera oficial). Editable por el usuario.
// Devuelve { hs, arancel (número % o null), reason }.
async function aiSuggestHS(title, cfg) {
  const schema = {
    type: 'OBJECT',
    properties: { hs: { type: 'STRING' }, arancel: { type: 'NUMBER' }, reason: { type: 'STRING' } },
    required: ['hs', 'arancel']
  };
  const p =
    `Eres experto en clasificación arancelaria de importaciones en COLOMBIA (Arancel de Aduanas, nomenclatura HS/NANDINA).\n` +
    `Producto que se importa desde China: "${title}".\n` +
    `Devuelve la SUBPARTIDA arancelaria colombiana (6 dígitos HS; 10 si la conoces) y el GRAVAMEN ARANCELARIO ad valorem general (%) que Colombia aplica a esa subpartida.\n` +
    `Los aranceles colombianos típicos son 0, 5, 10 o 15%. Da tu mejor estimación oficial (no incluyas IVA ni antidumping).\n` +
    `Responde SOLO este JSON: {"hs":"<código>","arancel":<número sin signo %>,"reason":"<justificación breve>"}`;
  const o = parseJSONLoose(await aiText(p, cfg, { schema, maxTokens: 300 })) || {};
  const arancel = parseFloat(o.arancel);
  return {
    hs: (o.hs || '').toString().trim(),
    arancel: isNaN(arancel) ? null : arancel,
    reason: (o.reason || '').toString().trim()
  };
}
