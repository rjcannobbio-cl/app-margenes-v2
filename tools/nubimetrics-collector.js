/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (v5, memoria)

   Corre en la consola de app.nubimetrics.com (sesión iniciada). Enumera el árbol
   con BFS (categorymarket, mismo origen; la CSP bloquea ML). Los RESULTADOS se
   guardan en MEMORIA (window._nubiData), no en localStorage (que se llenaba con
   ~10k categorías). El árbol de hojas sí se cachea en localStorage (más chico).

   IMPORTANTE: si venías de una versión anterior, RECARGA la página (F5) antes de
   pegar esto, para matar scripts viejos que quedaron corriendo.

   Métricas por hoja (una llamada al PADRE trae todas sus hojas):
     unidades=SuccessfulItemsReal · ticket=AverageTicketLocal
     GMV = unidades × ticket · competidores = SellersProfessionalReal ?? SellersProfessional
   Muchas categorías dan 401 (fuera del plan de la cuenta) → se saltan (los errores
   rojos de red en consola son esperables, no rompen nada).

   USO:
     NubiCollect.setCountry('cl')        // o 'co'
     await NubiCollect.run({months:1})   // 1 mes (rápido). Luego run() = 12 meses.
     NubiCollect.exportJSON()            // descarga JSON → importar en la app
   ============================================================ */

window.NubiCollect = (() => {
  const CFG = { cl: { seller: '613899966', site: 'MLC', currency: 'CLP' }, co: { seller: '1755397001', site: 'MCO', currency: 'COP' } };
  let C = CFG.cl;
  function setCountry(cc) { C = CFG[String(cc).toLowerCase()] || CFG.cl; console.log('[Nubi] País:', cc, C); }

  window._nubi = window._nubi || {};                        // { site: { data:{}, done:{} } }
  const mem = () => (window._nubi[C.site] = window._nubi[C.site] || { data: {}, done: {} });
  const LK = () => 'nubi_leaves_' + C.site;
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const saveLeaves = v => { try { localStorage.setItem(LK(), JSON.stringify(v)); } catch (e) { window._nubiLeaves = window._nubiLeaves || {}; window._nubiLeaves[C.site] = v; } };
  const loadLeaves = () => load(LK()) || (window._nubiLeaves && window._nubiLeaves[C.site]) || null;

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
  function extract(c) { const u = num(c.SuccessfulItemsReal), t = num(c.AverageTicketLocal); const p = c.SellersProfessionalReal != null ? num(c.SellersProfessionalReal) : num(c.SellersProfessional); return { gmv: (u != null && t != null) ? u * t : null, ticket: t, prof: p }; }
  async function mapLimit(items, limit, fn) { let i = 0; async function w() { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); }

  async function buildLeaves() {
    let leaves = loadLeaves();
    if (leaves && leaves.length) { console.log('[Nubi] hojas cacheadas:', leaves.length); return leaves; }
    leaves = []; const seen = new Set();
    const root = (unwrap(await catMarket('')).ChildrenCategories) || [];
    if (!root.length) { console.warn('[Nubi] root vacío'); return leaves; }
    console.log('[Nubi] L1:', root.length);
    let frontier = root.map(l => ({ id: l.Id, name: l.Name, l1: l.Name, pathIds: [l.Id] })), level = 1, forb = 0;
    while (frontier.length) {
      const next = [];
      await mapLimit(frontier, 8, async node => {
        const r = await catMarket(node.id);
        if (r.status !== 200) { if (r.status === 403) forb++; return; }
        const kids = (unwrap(r).ChildrenCategories) || [];
        if (!kids.length) { if (!seen.has(node.id)) { seen.add(node.id); leaves.push({ id: node.id, leaf: node.name, l1: node.l1, path: node.pathIds.join('-'), parentPath: node.pathIds.slice(0, -1).join('-') }); } }
        else for (const k of kids) next.push({ id: k.Id, name: k.Name, l1: node.l1, pathIds: node.pathIds.concat(k.Id) });
      });
      console.log(`[Nubi] nivel ${level}: ${frontier.length} → hojas ${leaves.length} · sig. ${next.length}${forb ? ' · 403 ' + forb : ''}`);
      frontier = next; level++;
    }
    saveLeaves(leaves); console.log('[Nubi] ✓ árbol · hojas:', leaves.length);
    return leaves;
  }

  async function run({ months = 12, limit = 6 } = {}) {
    const leaves = await buildLeaves(); if (!leaves.length) return 0;
    const monthList = lastMonths(months);
    const M = mem(), data = M.data, done = M.done;
    const byParent = {};
    for (const lf of leaves) (byParent[lf.parentPath] = byParent[lf.parentPath] || []).push(lf);
    const jobs = [];
    for (const p of Object.keys(byParent)) for (const m of monthList) if (!done[p + '@' + m]) jobs.push({ parent: p, month: m });
    console.log(`[Nubi] ${leaves.length} hojas · ${Object.keys(byParent).length} padres · ${monthList.length} meses · ${jobs.length} pendientes (guardando en memoria)`);
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
      if (++n % 100 === 0) console.log(`[Nubi] ${n}/${jobs.length} · hojas con datos: ${Object.keys(data).length}`);
    });
    console.log('[Nubi] ✓ Listo. hojas con datos:', Object.keys(data).length, '→ NubiCollect.exportJSON()');
    return Object.keys(data).length;
  }

  const avg = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  function exportJSON() {
    const data = mem().data;
    const arr = Object.entries(data).map(([id, d]) => ({ id, l1: d.l1, leaf: d.leaf, path: d.path, ventasGmv: avg(d.gmv), ticket: avg(d.ticket), competidores: avg(d.prof) })).filter(x => x.ventasGmv != null);
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nubimetrics_investigacion_${C.site}.json`; a.click();
    console.log('[Nubi] Exportadas', arr.length, 'hojas → importar en la app.');
  }
  function reset() { try { localStorage.removeItem(LK()); localStorage.removeItem('nubi_res_' + C.site); localStorage.removeItem('nubi_done_' + C.site); } catch (e) {} window._nubi[C.site] = { data: {}, done: {} }; console.log('[Nubi] borrado'); }

  return { setCountry, buildLeaves, run, exportJSON, reset };
})();
console.log("NubiCollect v5 (memoria) → setCountry('cl'); await run({months:1}); exportJSON()");
