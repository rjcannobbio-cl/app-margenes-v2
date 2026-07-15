/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (v4, batched + robusto)

   Corre en la consola de app.nubimetrics.com (sesión iniciada). Todo sale de
   Nubimetrics (la CSP bloquea api.mercadolibre.com). Enumera el árbol con BFS
   por tandas (rápido), salta categorías 403 (fuera de plan), guarda cada tanda
   (reanudable) y baja métricas por padre × mes.

   Métricas por hoja: unidades=SuccessfulItemsReal · ticket=AverageTicketLocal
     GMV = unidades × ticket · competidores = SellersProfessionalReal ?? SellersProfessional

   USO:
     NubiCollect.setCountry('cl')       // o 'co'
     await NubiCollect.buildLeaves()    // árbol (rápido, por niveles)
     await NubiCollect.run({months:1})  // 1 mes primero (tabla rápida). Luego run() = 12 meses.
     NubiCollect.exportJSON()           // descarga JSON → importar en la app
   ============================================================ */

window.NubiCollect = (() => {
  const CFG = { cl: { seller: '613899966', site: 'MLC', currency: 'CLP' }, co: { seller: '1755397001', site: 'MCO', currency: 'COP' } };
  let C = CFG.cl;
  function setCountry(cc) { C = CFG[String(cc).toLowerCase()] || CFG.cl; console.log('[Nubi] País:', cc, C); }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const LK = () => 'nubi_leaves_' + C.site, DK = () => 'nubi_res_' + C.site, JK = () => 'nubi_done_' + C.site;

  async function jget(url, ms = 12000) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { signal: ac.signal }); return { status: r.status, json: r.status === 200 ? await r.json().catch(() => null) : null }; }
    catch (e) { return { status: 0, json: null }; }
    finally { clearTimeout(t); }
  }
  function lastMonths(n) { const out = [], d = new Date(); d.setDate(1); for (let i = 1; i <= n; i++) { const x = new Date(d); x.setMonth(x.getMonth() - i); out.push(x.toISOString().slice(0, 8) + '01'); } return out; }
  const anchor = () => lastMonths(1)[0];
  const unwrap = r => (r.json && (r.json.data != null ? r.json.data : r.json)) || {};
  const catMarket = id => jget(`/api/shared/categorymarket?category=${id}&language=es&month=${anchor()}&seller_id=${C.seller}&site_id=${C.site}`);
  const catData = (path, month) => jget(`/api/Market/CategoryData?category=${path}&currency=${C.currency}&date=${month}&language=es&seller_id=${C.seller}&site_id=${C.site}`);
  const num = v => { const n = Number(v); return isNaN(n) ? null : n; };
  function extract(child) {
    const u = num(child.SuccessfulItemsReal), t = num(child.AverageTicketLocal);
    const prof = child.SellersProfessionalReal != null ? num(child.SellersProfessionalReal) : num(child.SellersProfessional);
    return { gmv: (u != null && t != null) ? u * t : null, ticket: t, prof };
  }
  async function mapLimit(items, limit, fn) {
    const out = []; let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // Enumera hojas por BFS (nivel a nivel, en tandas). Salta 403. Guarda cada tanda.
  async function buildLeaves() {
    let leaves = load(LK());
    if (leaves && leaves.length) { console.log('[Nubi] hojas cacheadas:', leaves.length); return leaves; }
    leaves = []; const seen = new Set();
    const root = (unwrap(await catMarket('')).ChildrenCategories) || [];
    if (!root.length) { console.warn('[Nubi] root vacío — avísame.'); return leaves; }
    console.log('[Nubi] L1:', root.length);
    let frontier = root.map(l1 => ({ id: l1.Id, name: l1.Name, l1: l1.Name, pathIds: [l1.Id] }));
    let level = 1, forbidden = 0;
    while (frontier.length) {
      const next = [];
      await mapLimit(frontier, 8, async node => {
        const r = await catMarket(node.id);
        if (r.status !== 200) { if (r.status === 403) forbidden++; return; }   // fuera de plan / error → saltar
        const kids = (unwrap(r).ChildrenCategories) || [];
        if (!kids.length) { if (!seen.has(node.id)) { seen.add(node.id); leaves.push({ id: node.id, leaf: node.name, l1: node.l1, path: node.pathIds.join('-'), parentPath: node.pathIds.slice(0, -1).join('-') }); } }
        else for (const k of kids) next.push({ id: k.Id, name: k.Name, l1: node.l1, pathIds: node.pathIds.concat(k.Id) });
      });
      save(LK(), leaves);
      console.log(`[Nubi] nivel ${level}: ${frontier.length} nodos → hojas ${leaves.length} · sig. ${next.length}${forbidden ? ' · 403 saltados ' + forbidden : ''}`);
      frontier = next; level++;
    }
    save(LK(), leaves);
    console.log('[Nubi] ✓ árbol listo · hojas:', leaves.length);
    return leaves;
  }

  // Baja métricas por padre × mes (una llamada al padre = todas sus hojas). Reanudable.
  async function run({ months = 12, limit = 6 } = {}) {
    const leaves = await buildLeaves();
    if (!leaves.length) return 0;
    const monthList = lastMonths(months);
    const data = load(DK()) || {}, done = load(JK()) || {};
    const byParent = {};
    for (const lf of leaves) (byParent[lf.parentPath] = byParent[lf.parentPath] || []).push(lf);
    const jobs = [];
    for (const p of Object.keys(byParent)) for (const m of monthList) if (!done[p + '@' + m]) jobs.push({ parent: p, month: m });
    console.log(`[Nubi] ${leaves.length} hojas · ${Object.keys(byParent).length} padres · ${monthList.length} meses · ${jobs.length} llamadas pendientes`);
    let n = 0;
    await mapLimit(jobs, limit, async j => {
      const r = await catData(j.parent, j.month);
      done[j.parent + '@' + j.month] = r.status;
      if (r.status === 200 && r.json) {
        const cats = ((r.json.data || r.json).Categories) || [];
        for (const lf of byParent[j.parent]) {
          const child = cats.find(x => x.CategoryId === lf.id); if (!child) continue;
          const e = extract(child);
          const d = data[lf.id] || (data[lf.id] = { l1: lf.l1, leaf: lf.leaf, path: lf.path, gmv: [], ticket: [], prof: [] });
          if (e.gmv != null) d.gmv.push(e.gmv); if (e.ticket != null) d.ticket.push(e.ticket); if (e.prof != null) d.prof.push(e.prof);
        }
      }
      if (++n % 60 === 0) { save(DK(), data); save(JK(), done); console.log(`[Nubi] ${n}/${jobs.length} · hojas con datos: ${Object.keys(data).length}`); }
    });
    save(DK(), data); save(JK(), done);
    console.log('[Nubi] ✓ Listo. NubiCollect.exportJSON()');
    return Object.keys(data).length;
  }

  const avg = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  function exportJSON() {
    const arr = Object.entries(load(DK()) || {}).map(([id, d]) => ({ id, l1: d.l1, leaf: d.leaf, path: d.path, ventasGmv: avg(d.gmv), ticket: avg(d.ticket), competidores: avg(d.prof) })).filter(x => x.ventasGmv != null);
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nubimetrics_investigacion_${C.site}.json`; a.click();
    console.log('[Nubi] Exportadas', arr.length, 'hojas → importar en la app.');
  }
  function reset() { [LK(), DK(), JK()].forEach(k => localStorage.removeItem(k)); console.log('[Nubi] progreso borrado'); }

  return { setCountry, buildLeaves, run, exportJSON, reset };
})();
console.log("NubiCollect v4 → setCountry('cl'); await buildLeaves(); await run({months:1}); exportJSON()");
