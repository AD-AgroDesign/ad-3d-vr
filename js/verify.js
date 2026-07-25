/* ============================================================
   verify.js — Reporte de regresión P1 (superficies, conteos de matas y
   error de proyección). Era el app.js de P1; se conserva como página
   aparte porque index.html pasó a ser la escena 3D en P2.

   Es la prueba de que el port NO movió ningún número respecto al
   proyecto original (HANDOFF §3.6): cualquier cambio futuro en
   core-*.js o proj.js que altere estos valores se ve acá al toque.
   ============================================================ */
"use strict";

/* ---------- Métricas de verificación ---------- */
const totalHa = s => Object.values(s).reduce((a, b) => a + b, 0);
const natureHa = s => NATURE_CLASSES.reduce((a, c) => a + (s[c] || 0), 0);
const F1 = n => n.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const FI = n => n.toLocaleString("es-AR");

function grassSummary(key) {
  const g = state.veg[key].grass, out = {};
  for (const cls of Object.keys(g)) {
    const list = g[cls];
    out[cls] = { total: list.length, conFlor: list.filter(t => !t.v).length, verdes: list.filter(t => t.v).length };
  }
  return out;
}

/* Verificación de proj.js contra la fórmula exacta de MapLibre (esperado ~0)
   y contra kx/ky equirectangular (divergencia N-S esperada, ~pocos m). */
function projCheck() {
  const R = 6371008.8, C = 2 * Math.PI * R;
  const mlX = lon => (180 + lon) / 360;
  const mlY = lat => (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;
  const [lon0, lat0] = state.center;
  const ox = mlX(lon0), oy = mlY(lat0), s = 1 / (C * Math.cos(lat0 * Math.PI / 180));
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
  let vsMl = 0, vsKxky = 0, n = 0;
  for (const f of state.data.multi.features) {
    for (const poly of f.geometry.coordinates) for (const [lon, lat] of poly[0]) {
      const [sx, sz] = lonLatToScene(lon, lat);
      vsMl = Math.max(vsMl, Math.hypot(sx - (mlX(lon) - ox) / s, sz - (mlY(lat) - oy) / s));
      vsKxky = Math.max(vsKxky, Math.hypot(sx - (lon - lon0) * kx, sz + (lat - lat0) * ky));
      n++;
    }
    if (n > 5000) break;
  }
  return { vsMl, vsKxky, n };
}

/* ---------- Reporte en pantalla ---------- */
function renderReport() {
  const si = state.stats.inicial, sm = state.stats.multi;
  const nIni = natureHa(si), nMul = natureHa(sm);
  const pc = projCheck();
  const gi = grassSummary("inicial"), gm = grassSummary("multi");

  const okMl = pc.vsMl < 1e-3;
  const present = CLASS_ORDER.filter(c => (si[c] || 0) + (sm[c] || 0) > 0);

  const row = (k, v, extra = "") => `<tr><td>${k}</td><td class="num">${v}</td><td class="hint">${extra}</td></tr>`;
  const classRows = present.map(c =>
    `<tr><td><span class="dot" style="background:${CLASS_META[c].legend}"></span>${CLASS_META[c].label}</td>` +
    `<td class="num">${F1(si[c] || 0)}</td><td class="num">${F1(sm[c] || 0)}</td></tr>`).join("");

  document.getElementById("report").innerHTML = `
    <h1>AgroDesign · Navegador 3D <span class="tag">VR</span></h1>
    <p class="sub">Verificación del núcleo de datos — <b>${state.campo.nombre}</b>
       ${state.campo.cliente && state.campo.cliente !== "AgroDesign" ? "· " + state.campo.cliente : ""}
       <span class="muted">(campo: <code>?campo=${state.campo.id}</code>)</span></p>

    <div class="grid">
      <section>
        <h2>Superficies</h2>
        <table>
          <thead><tr><th>Métrica</th><th>Inicial</th><th>Multifuncional</th></tr></thead>
          <tbody>
            <tr><td><b>Total</b></td><td class="num">${F1(totalHa(si))}</td><td class="num">${F1(totalHa(sm))}</td></tr>
            <tr><td><b>Naturaleza</b></td><td class="num">${F1(nIni)}</td><td class="num">${F1(nMul)}</td></tr>
            <tr><td>Variación naturaleza</td><td class="num">—</td><td class="num">+${Math.round((nMul / nIni - 1) * 100)} %</td></tr>
          </tbody>
        </table>
        <h2>Composición por clase (ha)</h2>
        <table><thead><tr><th>Clase</th><th>Inicial</th><th>Multi</th></tr></thead><tbody>${classRows}</tbody></table>
      </section>

      <section>
        <h2>Vegetación generada (semillas del original)</h2>
        <table>
          <thead><tr><th>Grupo</th><th>Inicial</th><th>Multi</th></tr></thead>
          <tbody>
            ${row("Árboles", "", "")}
            <tr><td class="ind">total</td><td class="num">${FI(state.veg.inicial.trees.length)}</td><td class="num">${FI(state.veg.multi.trees.length)}</td></tr>
            ${row("Matas corr-herb", "", "")}
            <tr><td class="ind">con flor (v=0)</td><td class="num">${FI(gi["corr-herb"]?.conFlor || 0)}</td><td class="num">${FI(gm["corr-herb"]?.conFlor || 0)}</td></tr>
            <tr><td class="ind">verdes (v=1)</td><td class="num">${FI(gi["corr-herb"]?.verdes || 0)}</td><td class="num">${FI(gm["corr-herb"]?.verdes || 0)}</td></tr>
            <tr><td class="ind">total</td><td class="num">${FI(gi["corr-herb"]?.total || 0)}</td><td class="num">${FI(gm["corr-herb"]?.total || 0)}</td></tr>
            ${row("Matas parche-herb", "", "")}
            <tr><td class="ind">total</td><td class="num">${FI(gi["parche-herb"]?.total || 0)}</td><td class="num">${FI(gm["parche-herb"]?.total || 0)}</td></tr>
          </tbody>
        </table>

        <h2>Proyección (proj.js)</h2>
        <table><tbody>
          <tr><td>Origen (lon, lat)</td><td class="num">${state.center[0].toFixed(5)}, ${state.center[1].toFixed(5)}</td></tr>
          <tr><td>metros / unidad Mercator</td><td class="num">${FI(Math.round(projInfo().mPerU))}</td></tr>
          <tr class="${okMl ? "ok" : "bad"}"><td>máx |Δ| vs MapLibre exacto</td><td class="num">${pc.vsMl.toExponential(2)} m ${okMl ? "✓" : "✗"}</td></tr>
          <tr><td>máx |Δ| vs kx/ky equirect.</td><td class="num">${F1(pc.vsKxky)} m <span class="hint">(N-S, esperado)</span></td></tr>
        </tbody></table>
      </section>
    </div>
    <p class="foot">Valores de referencia (HANDOFF §3.6): Silesia 468,6 ha · Monte Hermoso naturaleza
       91,7 → 263,5 ha (+187 %) · corr-herb multi 57.543 con flor / 57.162 verdes.
       <a href="index.html">→ ir a la escena 3D</a></p>
  `;
}

/* ---------- Arranque ---------- */
(async function main() {
  try {
    await loadCampos();
    await loadData();
    renderReport();
    if (DEBUG) {
      window.__vr = { state, projInfo, classify, lonLatToScene, sceneToLonLat, projCheck };
      console.log("window.__vr expuesto:", window.__vr);
    }
    document.getElementById("status").textContent =
      `THREE r${THREE.REVISION} · ${state.cfg.campos.length} campos · ${state.campo.nombre} OK`;
  } catch (err) {
    console.error(err);
    document.getElementById("report").innerHTML =
      `<h1 class="bad">Error en la verificación</h1><pre>${(err && err.stack) || err}</pre>`;
  }
})();
