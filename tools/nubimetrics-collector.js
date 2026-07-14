/* ============================================================
   Recolector Nubimetrics → Investigación de categorías (v2, validado)

   Nubimetrics NO tiene API key (auth por cookie de sesión) → corre EN TU NAVEGADOR,
   en una pestaña logueada de app.nubimetrics.com. Fuente: "Mercado Libre visión
   global" (/market/bycategory) = endpoint /api/Market/CategoryData.

   CLAVE (validado): CategoryData necesita el PATH COMPLETO de la categoría con
   guiones (ej. MCO1182-MCO442089-MCO2987), NO el id suelto. Una hoja no tiene
   hijos → se pide su PADRE y se busca la hoja dentro de data.Categories[].
   Métricas por hoja:
     unidades = SuccessfulItemsReal · ticket = AverageTicketLocal
     GMV (venta total) = unidades × ticket   (Gmv/SuccessfulItems son share %, NO usar)
     competidores prof. = SellersProfessionalReal ?? SellersProfessional  (⚠️ a validar)

   USO (en la consola de app.nubimetrics.com, tras escribir 'allow pasting'):
     NubiCollect.setCountry('cl')          // o 'co'
     await NubiCollect.sample('MLC5713')   // prueba 1 hoja/mes (valida campos)
     await NubiCollect.run()               // recorre todo (miles, reanudable)
     NubiCollect.exportJSON()              // descarga el JSON → importar en la app

   Gotchas cubiertos: AbortController (fetch cuelga), tandas (concurrencia), reanudable
   por localStorage, categorías 401 marcadas y saltadas.
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
  // Últimos N meses completos (excluye el mes en curso) como YYYY-MM-01.
  function lastMonths(n) {
    const out = [], d = new Date(); d.setDate(1);
    for (let i = 1; i <= n; i++) { const x = new Date(d); x.setMonth(x.getMonth() - i); out.push(x.toISOString().slice(0, 8) + '01'); }
    return out;
  }
  const catData = (path, month) => jget(`/api/Market/CategoryData?category=${path}&currency=${C.currency}&date=${month}&language=es&seller_id=${C.seller}&site_id=${C.site}`);
  function extract(child) {
    const u = Number(child.SuccessfulItemsReal), t = Number(child.AverageTicketLocal);
    const prof = child.SellersProfessionalReal != null ? Number(child.SellersProfessionalReal)
      : (child.SellersProfessional != null ? Number(child.SellersProfessional) : null);
    return { unidades: isNaN(u) ? null : u, ticket: isNaN(t) ? null : t, gmv: (!isNaN(u) && !isNaN(t)) ? u * t : null, prof: (prof != null && !isNaN(prof)) ? prof : null };
  }

  // Prueba rápida: métricas de UNA hoja en el último mes (valida campos antes del run grande).
  async function sample(leafId) {
    const pf = await fetch('https://api.mercadolibre.com/categories/' + leafId).then(r => r.json());
    const ids = (pf.path_from_root || []).map(p => p.id);
    const parent = ids.slice(0, -1).join('-');
    const month = lastMonths(1)[0];
    const r = await catData(parent, month);
    const cats = (r.json && (r.json.data || r.json).Categories) || [];
    const child = cats.find(x => x.CategoryId === leafId);
    return { status: r.status, month, leaf: pf.name, parent, encontrada: !!child, metricas: child ? extract(child) : null, rawSellers: child ? { SellersProfessional: child.SellersProfessional, SellersProfessionalReal: child.SellersProfessionalReal, SellersPlatinum: child.SellersPlatinum } : null };
  }

  // Enumera categorías hoja vía API pública de ML (id, nombre, L1, path, path del padre).
  async function buildLeaves() {
    let leaves = load(LK());
    if (leaves && leaves.length) { console.log('[Nubi] hojas cacheadas:', leaves.length); return leaves; }
    console.log('[Nubi] enumerando hojas de', C.site, '(API pública ML)…');
    const l1s = await fetch(`https://api.mercadolibre.com/sites/${C.site}/categories`).then(r => r.json());
    leaves = []; const seen = new Set();
    async function walk(id) {
      const c = await fetch('https://api.mercadolibre.com/categories/' + id).then(r => r.json()).catch(() => null);
      if (!c) return;
      const kids = c.children_categories || [];
      if (!kids.length) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          const pfr = (c.path_from_root || []).map(p => p.id);
          leaves.push({ id: c.id, leaf: c.name, l1: ((c.path_from_root || [])[0] || {}).name || '', path: pfr.join('-'), parentPath: pfr.slice(0, -1).join('-') });
        }
        return;
      }
      for (const k of kids) { await walk(k.id); await sleep(25); }
    }
    for (const l1 of l1s) { await walk(l1.id); save(LK(), leaves); console.log('[Nubi]', l1.name, '· hojas:', leaves.length); }
    save(LK(), leaves);
    return leaves;
  }

  // Recorre padre × mes (agrupa hojas por padre → mínimas llamadas). Reanudable.
  async function run({ months = 12, batch = 6, delay = 250 } = {}) {
    const leaves = await buildLeaves();
    const monthList = lastMonths(months);
    const data = load(DK()) || {};
    const done = load(JK()) || {};
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
    const arr = Object.entries(load(DK()) || {}).map(([id, d]) => ({
      id, l1: d.l1, leaf: d.leaf, path: d.path,
      ventasGmv: avg(d.gmv), ticket: avg(d.ticket), competidores: avg(d.prof)
    })).filter(x => x.ventasGmv != null);
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nubimetrics_investigacion_${C.site}.json`; a.click();
    console.log('[Nubi] Exportadas', arr.length, 'hojas → importar en la app (Investigación → Importar datos).');
  }
  function reset() { [LK(), DK(), JK()].forEach(k => localStorage.removeItem(k)); console.log('[Nubi] progreso borrado para', C.site); }

  return { setCountry, sample, buildLeaves, run, exportJSON, reset };
})();
console.log("NubiCollect v2 →  NubiCollect.setCountry('cl');  await NubiCollect.sample('MLC5713');  await NubiCollect.run();  NubiCollect.exportJSON()");
