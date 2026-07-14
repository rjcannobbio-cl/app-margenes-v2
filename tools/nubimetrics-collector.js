/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (v3, validado en vivo)

   Corre EN TU NAVEGADOR, en una pestaña logueada de app.nubimetrics.com
   (auth por cookie de sesión; no hay API key). TODO sale de Nubimetrics: la
   página tiene CSP que BLOQUEA api.mercadolibre.com, así que el árbol de
   categorías se arma con /api/shared/categorymarket (mismo origen).

   Cadena validada:
     categorymarket(id) → { PathFromRoot (JSON string), ChildrenCategories[]{Id,Level,Name} }
       · hoja = ChildrenCategories vacío.
     CategoryData(PATH_DEL_PADRE, YYYY-MM-01) → data.Categories[] (hijos con métricas).
       Buscar la hoja por CategoryId. IMPORTANTE: usar el PATH COMPLETO con guiones.
     Por hoja: unidades=SuccessfulItemsReal · ticket=AverageTicketLocal
       GMV = unidades × ticket   (Gmv/SuccessfulItems son share %, NO usar)
       competidores prof = SellersProfessionalReal ?? SellersProfessional

   USO (consola de app.nubimetrics.com, con 'allow pasting'):
     NubiCollect.setCountry('cl')            // o 'co'
     await NubiCollect.sample('MLC5713')     // valida 1 hoja
     await NubiCollect.buildLeaves()         // arma el árbol (una vez, se cachea)
     await NubiCollect.run()                 // baja métricas (12 meses, reanudable)
     NubiCollect.exportJSON()                // descarga JSON → importar en la app
   ============================================================ */

window.NubiCollect = (() => {
  const CFG = {
    cl: { seller: '613899966', site: 'MLC', currency: 'CLP' },
    co: { seller: '1755397001', site: 'MCO', currency: 'COP' }
  };
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
  function extract(child) {
    const u = Number(child.SuccessfulItemsReal), t = Number(child.AverageTicketLocal);
    const prof = child.SellersProfessionalReal != null ? Number(child.SellersProfessionalReal) : (child.SellersProfessional != null ? Number(child.SellersProfessional) : null);
    return { unidades: isNaN(u) ? null : u, ticket: isNaN(t) ? null : t, gmv: (!isNaN(u) && !isNaN(t)) ? u * t : null, prof: (prof != null && !isNaN(prof)) ? prof : null };
  }
  function pathOf(cm) { let p = cm.PathFromRoot; try { if (typeof p === 'string') p = JSON.parse(p); } catch (e) { p = null; } return Array.isArray(p) ? p : []; }

  // Prueba: métricas de UNA hoja en el último mes.
  async function sample(leafId) {
    const g0 = unwrap(await catMarket(leafId));
    const pfr = pathOf(g0), ids = pfr.map(p => p.Id || p.id);
    const parent = ids.slice(0, -1).join('-');
    const month = anchor();
    const r = await catData(parent, month);
    const child = ((r.json && (r.json.data || r.json).Categories) || []).find(x => x.CategoryId === leafId);
    return { status: r.status, month, leaf: (pfr.slice(-1)[0] || {}).Name, parent, encontrada: !!child, metricas: child ? extract(child) : null };
  }

  // Enumera hojas caminando el árbol de Nubimetrics (categorymarket). Cachea en localStorage.
  async function buildLeaves() {
    let leaves = load(LK());
    if (leaves && leaves.length) { console.log('[Nubi] hojas cacheadas:', leaves.length); return leaves; }
    console.log('[Nubi] enumerando árbol de', C.site, 'desde Nubimetrics…');
    leaves = []; const seen = new Set();
    const rootKids = (unwrap(await catMarket('')).ChildrenCategories) || [];
    if (!rootKids.length) { console.warn('[Nubi] categorymarket(root) vino vacío — avísame para usar el endpoint de L1.'); return leaves; }
    console.log('[Nubi] L1 encontrados:', rootKids.length);
    async function walk(node) {
      const kids = (unwrap(await catMarket(node.id)).ChildrenCategories) || [];
      if (!kids.length) {
        if (!seen.has(node.id)) { seen.add(node.id); leaves.push({ id: node.id, leaf: node.name, l1: node.l1, path: node.pathIds.join('-'), parentPath: node.pathIds.slice(0, -1).join('-') }); }
        return;
      }
      for (const k of kids) { await walk({ id: k.Id, name: k.Name, l1: node.l1, pathIds: node.pathIds.concat(k.Id) }); await sleep(20); }
    }
    for (const l1 of rootKids) { await walk({ id: l1.Id, name: l1.Name, l1: l1.Name, pathIds: [l1.Id] }); save(LK(), leaves); console.log('[Nubi]', l1.Name, '· hojas acumuladas:', leaves.length); }
    save(LK(), leaves); return leaves;
  }

  // Baja métricas por padre × mes (agrupa hojas por padre). Reanudable.
  async function run({ months = 12, batch = 6, delay = 250 } = {}) {
    const leaves = await buildLeaves();
    if (!leaves.length) { console.warn('[Nubi] sin hojas — corre buildLeaves() primero.'); return 0; }
    const monthList = lastMonths(months);
    const data = load(DK()) || {}, done = load(JK()) || {};
    const byParent = {};
    for (const lf of leaves) (byParent[lf.parentPath] = byParent[lf.parentPath] || []).push(lf);
    const jobs = [];
    for (const p of Object.keys(byParent)) for (const m of monthList) jobs.push({ parent: p, month: m });
    console.log(`[Nubi] ${leaves.length} hojas · ${Object.keys(byParent).length} padres · ${monthList.length} meses · ${jobs.length} llamadas`);
    for (let i = 0; i < jobs.length; i += batch) {
      const chunk = jobs.slice(i, i + batch).filter(j => !done[j.parent + '@' + j.month]);
      if (chunk.length) await Promise.all(chunk.map(async j => {
        const r = await catData(j.parent, j.month);
        done[j.parent + '@' + j.month] = r.status;
        if (r.status === 200 && r.json) {
          const cats = ((r.json.data || r.json).Categories) || [];
          for (const lf of byParent[j.parent]) {
            const child = cats.find(x => x.CategoryId === lf.id); if (!child) continue;
            const e = extract(child);
            const d = data[lf.id] || (data[lf.id] = { l1: lf.l1, leaf: lf.leaf, path: lf.path, gmv: [], ticket: [], prof: [] });
            if (e.gmv != null) d.gmv.push(e.gmv);
            if (e.ticket != null) d.ticket.push(e.ticket);
            if (e.prof != null) d.prof.push(e.prof);
          }
        }
      }));
      save(DK(), data); save(JK(), done);
      if (i % (batch * 10) === 0) console.log(`[Nubi] ${Math.min(i + batch, jobs.length)}/${jobs.length} · hojas con datos: ${Object.keys(data).length}`);
      await sleep(delay);
    }
    console.log('[Nubi] ✓ Listo. Ejecuta NubiCollect.exportJSON()');
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

  return { setCountry, sample, buildLeaves, run, exportJSON, reset };
})();
console.log("NubiCollect v3 listo → setCountry('cl'); await sample('MLC5713'); await run(); exportJSON()");
