/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (borrador v1)

   Nubimetrics NO tiene API key: la auth es por cookie de sesión. Por eso este
   script corre EN TU NAVEGADOR, en una pestaña logueada de app.nubimetrics.com.

   USO:
   1. Abre https://app.nubimetrics.com con tu sesión iniciada.
   2. Abre la consola del navegador (F12 → Console) y pega TODO este archivo.
   3. Ejecuta:   await NubiCollect.run()
      - Enumera todas las categorías hoja (API pública de ML) y baja, por cada una,
        la "visión global" (seasonalitygraphics): promedia los últimos 12 meses de
        GMV, ticket y competidores profesionales.
      - Es reanudable: guarda progreso en localStorage. Si lo cortas, vuelve a
        ejecutar run() y sigue donde quedó. Son miles de categorías → puede tardar.
   4. Al terminar:   NubiCollect.exportJSON()
      Descarga un JSON que importas en margenes.etbrands.cl → Investigación → Importar datos.

   NOTA: v1 sin validar contra la API real (la navegación a Nubimetrics está
   bloqueada en el entorno del asistente). El punto a verificar es el envoltorio de
   la respuesta de seasonalitygraphics y los nombres de las series — ver fetchLeaf().
   ============================================================ */

window.NubiCollect = (() => {
  const SITE = 'MLC', SELLER = '613899966';
  const LS_LEAVES = 'nubi_leaves', LS_DATA = 'nubi_research_data';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // ---- Fase 1: enumerar categorías hoja (API pública de ML, sin sesión) ----
  async function buildLeaves() {
    let leaves = load(LS_LEAVES);
    if (leaves && leaves.length) { console.log('[Nubi] Hojas cacheadas:', leaves.length); return leaves; }
    console.log('[Nubi] Enumerando categorías hoja desde Mercado Libre…');
    const l1s = await fetch(`https://api.mercadolibre.com/sites/${SITE}/categories`).then(r => r.json());
    leaves = []; const seen = new Set();
    async function walk(catId) {
      const c = await fetch(`https://api.mercadolibre.com/categories/${catId}`).then(r => r.json()).catch(() => null);
      if (!c) return;
      const kids = c.children_categories || [];
      if (!kids.length) {
        const pfr = c.path_from_root || [];
        if (!seen.has(c.id)) { seen.add(c.id); leaves.push({ id: c.id, l1: (pfr[0] || {}).name || '', leaf: c.name, path: pfr.map(p => p.id).join('-') }); }
        return;
      }
      for (const k of kids) { await walk(k.id); await sleep(30); }
    }
    for (const l1 of l1s) { await walk(l1.id); save(LS_LEAVES, leaves); console.log('[Nubi] L1 listo:', l1.name, '· hojas acumuladas:', leaves.length); }
    save(LS_LEAVES, leaves);
    return leaves;
  }

  // ---- Fase 2: métricas por hoja (Nubimetrics, promedio 12 meses) ----
  function avg12(series) {
    if (!Array.isArray(series) || !series.length) return null;
    const vals = series.map(p => Number(p.Value != null ? p.Value : p.value)).filter(v => !isNaN(v));
    const last = vals.slice(-12);
    return last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
  }
  async function fetchLeaf(leaf) {
    const url = `/api/market/seasonalitygraphics?category=${leaf.id}&seller_id=${SELLER}&site_id=${SITE}`;
    const d = await fetch(url).then(r => r.json()).catch(() => null);
    // ⚠️ VERIFICAR EN EL SPIKE: el envoltorio puede ser d.data, d.value o d directo,
    // y las series pueden venir como claves sueltas o dentro de graphics[].
    const g = (d && (d.data != null ? d.data : d)) || {};
    const s = name => g[name] || (Array.isArray(g.graphics) ? (g.graphics.find(x => x.Name === name) || {}).Values : null) || null;
    return {
      id: leaf.id, l1: leaf.l1, leaf: leaf.leaf, path: leaf.path,
      ventasGmv: avg12(s('CategoryGmvLocal')),
      ticket: avg12(s('CategoryAverageTicketLocal')),
      competidores: avg12(s('CategorySellersProfessional'))
    };
  }

  async function run({ batch = 4, delay = 350 } = {}) {
    const leaves = await buildLeaves();
    const data = load(LS_DATA) || {};
    const pending = leaves.filter(l => !data[l.id]);
    console.log(`[Nubi] ${leaves.length} hojas · faltan ${pending.length}`);
    for (let i = 0; i < pending.length; i += batch) {
      const chunk = pending.slice(i, i + batch);
      const res = await Promise.all(chunk.map(l => fetchLeaf(l).catch(() => null)));
      res.forEach(r => { if (r) data[r.id] = r; });
      save(LS_DATA, data);
      if (i % 40 === 0) console.log(`[Nubi] ${Object.keys(data).length}/${leaves.length}`);
      await sleep(delay);
    }
    console.log('[Nubi] ✓ Listo. Ejecuta NubiCollect.exportJSON()');
    return Object.keys(data).length;
  }

  function exportJSON() {
    const arr = Object.values(load(LS_DATA) || {});
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'nubimetrics_investigacion.json'; a.click();
    console.log('[Nubi] Exportadas', arr.length, 'categorías. Impórtalo en la app (Investigación → Importar datos).');
  }
  function reset() { localStorage.removeItem(LS_LEAVES); localStorage.removeItem(LS_DATA); console.log('[Nubi] Progreso borrado.'); }

  return { run, exportJSON, reset, buildLeaves };
})();
console.log('NubiCollect listo →  await NubiCollect.run()  y al terminar  NubiCollect.exportJSON()');
