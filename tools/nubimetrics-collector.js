/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (v7)

   Corre en la consola de app.nubimetrics.com (sesión iniciada). Fuente: "Mercado
   por Categorías / visión global" = /api/Market/CategoryData. Árbol vía
   /api/shared/categorymarket (mismo origen; la CSP bloquea api.mercadolibre.com).

   Métricas por hoja (una llamada al PADRE trae todas sus hojas):
     unidades=SuccessfulItemsReal · ticket=AverageTicketLocal · GMV=unidades×ticket
     competidores = SellersPlatinum ("Vendedores Platinum")
     (Gmv, SuccessfulItems y SellersProfessional son SHARE %, NO se usan.)

   Novedades v7:
     · Árbol se cachea con flag "complete" → nunca reusa una enumeración a medias.
     · Padres que dan 401/403 (fuera del plan de la cuenta) se cachean y se SALTAN
       en los próximos runs (más rápido). coverage() muestra hojas con datos por L1.

   USO:
     NubiCollect.setCountry('cl')        // o 'co'
     NubiCollect.reset()                 // solo la 1ª vez o si el árbol quedó a medias
     await NubiCollect.run({months:1})   // 1 mes (rápido). Luego run() = 12 meses.
     NubiCollect.coverage()              // cuántas hojas con datos por L1
     NubiCollect.exportJSON()            // descarga JSON → importar en la app
   ============================================================ */

window.NubiCollect = (() => {
  const CFG = { cl: { seller: '613899966', site: 'MLC', currency: 'CLP' }, co: { seller: '1755397001', site: 'MCO', currency: 'COP' } };
  let C = CFG.cl;
  function setCountry(cc) { C = CFG[String(cc).toLowerCase()] || CFG.cl; console.log('[Nubi] País:', cc, C); }

  window._nubi = window._nubi || {};
  const mem = () => (window._nubi[C.site] = window._nubi[C.site] || { data: {}, done: {} });
  const LK = () => 'nubi_leaves_' + C.site, XK = () => 'nubi_dead_' + C.site;
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  // Árbol de hojas: se guarda { complete, leaves }. Solo se reusa si complete=true.
  function saveLeaves(leaves, complete) { if (!store(LK(), { complete: !!complete, leaves })) { window._nubiLeaves = window._nubiLeaves || {}; window._nubiLeaves[C.site] = { complete, leaves }; } }
  function loadLeaves() { const o = load(LK()) || (window._nubiLeaves && window._nubiLeaves[C.site]); return (o && o.complete && o.leaves && o.leaves.length) ? o.leaves : null; }
  // Padres 401/403 (fuera de plan) → se saltan.
  const deadSet = () => new Set(load(XK()) || []);
  const saveDead = set => store(XK(), [...set]);

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
  function extract(c) { const u = num(c.SuccessfulItemsReal), t = num(c.AverageTicketLocal); return { gmv: (u != null && t != null) ? u * t : null, ticket: t, prof: num(c.SellersPlatinum) }; }
  async function mapLimit(items, limit, fn) { let i = 0; async function w() { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); }

  async function buildLeaves() {
    let leaves = loadLeaves();
    if (leaves) { console.log('[Nubi] árbol cacheado (completo):', leaves.length, 'hojas'); return leaves; }
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
      saveLeaves(leaves, false);   // parcial (por si se corta)
      console.log(`[Nubi] nivel ${level}: ${frontier.length} → hojas ${leaves.length} · sig. ${next.length}${forb ? ' · 403 ' + forb : ''}`);
      frontier = next; level++;
    }
    saveLeaves(leaves, true);   // ✓ completo
    console.log('[Nubi] ✓ árbol COMPLETO · hojas:', leaves.length);
    return leaves;
  }

  async function run({ months = 12, limit = 6 } = {}) {
    const leaves = await buildLeaves(); if (!leaves.length) return 0;
    const monthList = lastMonths(months);
    const M = mem(), data = M.data, done = M.done, dead = deadSet();
    const byParent = {};
    for (const lf of leaves) (byParent[lf.parentPath] = byParent[lf.parentPath] || []).push(lf);
    const parents = Object.keys(byParent).filter(p => !dead.has(p));
    const jobs = [];
    for (const p of parents) for (const m of monthList) if (!done[p + '@' + m]) jobs.push({ parent: p, month: m });
    console.log(`[Nubi] ${leaves.length} hojas · ${Object.keys(byParent).length} padres (${dead.size} saltados por 401) · ${monthList.length} meses · ${jobs.length} pendientes`);
    let n = 0, newDead = 0;
    await mapLimit(jobs, limit, async j => {
      const r = await catData(j.parent, j.month);
      done[j.parent + '@' + j.month] = r.status;
      if (r.status === 401 || r.status === 403) { if (!dead.has(j.parent)) { dead.add(j.parent); newDead++; } }
      else if (r.status === 200 && r.json) {
        const cats = ((r.json.data || r.json).Categories) || [];
        for (const lf of byParent[j.parent]) {
          const child = cats.find(x => x.CategoryId === lf.id); if (!child) continue;
          const e = extract(child);
          const d = data[lf.id] || (data[lf.id] = { l1: lf.l1, leaf: lf.leaf, path: lf.path, gmv: [], ticket: [], prof: [] });
          if (e.gmv != null) d.gmv.push(e.gmv); if (e.ticket != null) d.ticket.push(e.ticket); if (e.prof != null) d.prof.push(e.prof);
        }
      }
      if (++n % 100 === 0) { saveDead(dead); console.log(`[Nubi] ${n}/${jobs.length} · hojas con datos: ${Object.keys(data).length} · nuevos 401: ${newDead}`); }
    });
    saveDead(dead);
    console.log('[Nubi] ✓ Listo. hojas con datos:', Object.keys(data).length, '· padres 401 cacheados:', dead.size, '→ coverage() / exportJSON()');
    return Object.keys(data).length;
  }

  const avg = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  function coverage() {
    const d = mem().data, byL1 = {};
    for (const k in d) { const l1 = d[k].l1 || '?'; byL1[l1] = (byL1[l1] || 0) + 1; }
    console.log('[Nubi] Hojas con datos por L1:');
    Object.entries(byL1).sort((a, b) => b[1] - a[1]).forEach(([l1, n]) => console.log('  ' + String(n).padStart(5) + '  ' + l1));
    console.log('[Nubi] Total:', Object.keys(d).length, '· padres 401 cacheados:', deadSet().size);
    return byL1;
  }
  function exportJSON() {
    const d = mem().data;
    const arr = Object.entries(d).map(([id, x]) => ({ id, l1: x.l1, leaf: x.leaf, path: x.path, ventasGmv: avg(x.gmv), ticket: avg(x.ticket), competidores: avg(x.prof) })).filter(x => x.ventasGmv > 0);
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nubimetrics_investigacion_${C.site}.json`; a.click();
    console.log('[Nubi] Exportadas', arr.length, 'hojas (con ventas > 0) → importar en la app.');
  }
  function resetData() { window._nubi[C.site] = { data: {}, done: {} }; console.log('[Nubi] resultados borrados (árbol se conserva)'); }
  function reset() { try { localStorage.removeItem(LK()); localStorage.removeItem(XK()); } catch (e) {} if (window._nubiLeaves) delete window._nubiLeaves[C.site]; window._nubi[C.site] = { data: {}, done: {} }; console.log('[Nubi] borrado total (árbol + resultados + 401)'); }

  return { setCountry, buildLeaves, run, coverage, exportJSON, reset, resetData };
})();
console.log("NubiCollect v7 → setCountry('cl'); reset(); await run({months:1}); coverage(); exportJSON()");
