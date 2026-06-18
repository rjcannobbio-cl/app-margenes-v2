/* ============================================================
   Predicción de categoría con IA LOCAL (en el navegador, sin API key)
   transformers.js + embeddings multilingües. Búsqueda semántica en dos etapas:
   (1) elegir el L1 más cercano al título; (2) elegir la hoja más cercana dentro del L1.
   ============================================================ */
'use strict';

const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const LOCAL_LIB = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

let _extractor = null, _loading = null;

async function loadExtractor(onStatus) {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = (async () => {
    if (onStatus) onStatus('Cargando modelo de IA local (1ª vez, ~120 MB)…');
    const mod = await import(LOCAL_LIB);
    mod.env.allowLocalModels = false;     // descargar pesos desde Hugging Face
    _extractor = await mod.pipeline('feature-extraction', LOCAL_MODEL, { quantized: true });
    return _extractor;
  })();
  return _loading;
}

// Devuelve un array de vectores (uno por texto), ya normalizados (mean pooling).
async function embedTexts(texts) {
  const ex = await loadExtractor();
  const out = await ex(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Caches en memoria de los embeddings de categorías (se calculan una vez por sesión)
const _l1Cache = {};    // channelKey -> { names:[], vecs:[][] }
const _leafCache = {};  // channelKey + '|' + l1 -> { idxs:[], vecs:[][] }

async function l1Embeddings(channelKey, list) {
  if (_l1Cache[channelKey]) return _l1Cache[channelKey];
  const names = listL1s(list);
  const vecs = await embedTexts(names);
  _l1Cache[channelKey] = { names, vecs };
  return _l1Cache[channelKey];
}

async function leafEmbeddings(channelKey, l1, list, onStatus) {
  const key = channelKey + '|' + l1;
  if (_leafCache[key]) return _leafCache[key];
  const idxs = [], texts = [];
  for (let i = 0; i < list.length; i++) {
    if ((list[i].path || list[i].name).split(' > ')[0].trim() === l1) { idxs.push(i); texts.push(list[i].name); }
  }
  if (onStatus) onStatus('Indexando "' + l1 + '" (' + texts.length + ' subcategorías)…');
  const vecs = await embedTexts(texts);
  _leafCache[key] = { idxs, vecs };
  return _leafCache[key];
}

// Etapa 1 + 2 para un canal. Devuelve el índice global en `list`.
async function localPickChannel(titleVec, channelKey, list, onStatus) {
  const { names, vecs } = await l1Embeddings(channelKey, list);
  let bi = 0, bs = -2;
  for (let i = 0; i < vecs.length; i++) { const s = cosine(titleVec, vecs[i]); if (s > bs) { bs = s; bi = i; } }
  const l1 = names[bi];
  const { idxs, vecs: lv } = await leafEmbeddings(channelKey, l1, list, onStatus);
  let li = 0, ls = -2;
  for (let i = 0; i < lv.length; i++) { const s = cosine(titleVec, lv[i]); if (s > ls) { ls = s; li = i; } }
  return idxs[li];
}

// Predicción local para ambos canales. onStatus(msg) para feedback de carga.
async function localSuggestBoth(title, onStatus) {
  await loadExtractor(onStatus);
  if (onStatus) onStatus('Analizando con IA local…');
  const [tv] = await embedTexts([title]);
  const ml = await localPickChannel(tv, 'ml', ML_CATEGORIES, onStatus);
  const fbla = await localPickChannel(tv, 'fbla', FBLA_CATEGORIES, onStatus);
  return { ml, fbla, raw: { mode: 'local' } };
}
