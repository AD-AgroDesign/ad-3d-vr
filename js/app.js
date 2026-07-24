/* ============================================================
   app.js — Orquestación P0/P1 de la variante VR.
   P0: prueba de que el Three.js vendorizado carga (cubo girando).
   P1: carga de un campo SIN MapLibre, anotación _cls/_sup, stats, bbox,
       proyección Mercator (proj.js) y generación de vegetación con las
       semillas del original. Vuelca un reporte de verificación a pantalla
       y expone window.__vr con ?debug. NO hay render de escena todavía
       (eso es P2): esta pantalla es una herramienta de validación.
   ============================================================ */
"use strict";

const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug") || params.has("fps");

const state = {
  campo: null,
  cfg: null,
  data: { inicial: null, multi: null },
  veg: { inicial: null, multi: null },
  stats: { inicial: {}, multi: {} },
  bbox: null,
  center: null
};

/* ---------- Carga de configuración y datos (sin MapLibre) ---------- */
async function loadCampos() {
  // no-cache: igual que el original, para que cambios de config lleguen a
  // usuarios con la página ya cacheada (lección heredada, HANDOFF §12).
  const cfg = await fetch("data/campos.json", { cache: "no-cache" }).then(r => r.json());
  state.cfg = cfg;
  const wanted = params.get("campo") || cfg.default;
  state.campo = cfg.campos.find(c => c.id === wanted) || cfg.campos[0];
  return cfg;
}

function normalizeFC(fc) {
  for (const f of fc.features) {
    // Defensivo: convertir Polygon → MultiPolygon para iterar uniforme (§3.5)
    if (f.geometry && f.geometry.type === "Polygon")
      f.geometry = { type: "MultiPolygon", coordinates: [f.geometry.coordinates] };
    f.properties._cls = classify(f.properties);
    // superficie: del atributo si existe, si no calculada de la geometría
    let sup = f.properties.Sup ?? f.properties.SUP ?? f.properties.sup;
    if (sup == null || sup === 0)
      sup = f.geometry.coordinates.reduce((s, poly) => s + ringAreaHa(poly[0], poly[0][0][1]), 0);
    f.properties._sup = sup;
  }
  return fc;
}

function computeStats() {
  for (const [key, fc] of [["inicial", state.data.inicial], ["multi", state.data.multi]]) {
    const sums = {};
    for (const f of fc.features) {
      const cls = f.properties._cls;
      sums[cls] = (sums[cls] || 0) + (f.properties._sup || 0);
    }
    state.stats[key] = sums;
  }
}

function computeBBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fc of [state.data.inicial, state.data.multi]) {
    for (const f of fc.features) {
      for (const poly of f.geometry.coordinates) {
        const [a, b, c, d] = ringBBox(poly[0]);
        if (a < minX) minX = a; if (b < minY) minY = b;
        if (c > maxX) maxX = c; if (d > maxY) maxY = d;
      }
    }
  }
  state.bbox = [[minX, minY], [maxX, maxY]];
  state.center = [(minX + maxX) / 2, (minY + maxY) / 2];
}

async function loadData() {
  const [ini, multi] = await Promise.all([
    fetch(state.campo.inicial).then(r => r.json()),
    fetch(state.campo.multifuncional).then(r => r.json())
  ]);
  normalizeFC(ini); normalizeFC(multi);
  state.data.inicial = ini;
  state.data.multi = multi;
  computeStats();
  computeBBox();
  // Origen de proyección = centro del bbox del campo (una vez por campo)
  setProjectionOrigin(state.center[0], state.center[1]);
  // Vegetación con las MISMAS semillas del original (paridad exacta, §3.4)
  state.veg.inicial = generateTreeData(ini, 20260711);
  state.veg.multi = generateTreeData(multi, 47110226);
  state.veg.inicial.grass = generateGrassData(ini, 13072026);
  state.veg.multi.grass = generateGrassData(multi, 62027031);
}

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
    <p class="sub">Verificación P0/P1 — <b>${state.campo.nombre}</b>
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
    <p class="foot">Núcleo de datos portado sin MapLibre. Siguiente: <b>P2 — escena Three.js</b>.
       ${DEBUG ? '<code>window.__vr</code> disponible en consola.' : 'Agregá <code>?debug</code> para exponer <code>window.__vr</code>.'}</p>
  `;
}

/* ---------- P0: cubo girando (prueba de que Three carga) ---------- */
function startCube() {
  const canvas = document.getElementById("cube");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(120, 120, false);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  cam.position.set(0, 0, 3);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1, 1, 1); scene.add(dl);
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 1.3, 1.3),
    new THREE.MeshPhongMaterial({ color: 0x3e6d2f, flatShading: true })
  );
  scene.add(cube);
  (function spin() {
    cube.rotation.x += 0.01; cube.rotation.y += 0.014;
    renderer.render(scene, cam);
    requestAnimationFrame(spin);
  })();
}

/* ---------- Arranque ---------- */
(async function main() {
  try {
    startCube();  // P0
    await loadCampos();
    await loadData();
    renderReport();
    if (DEBUG) {
      window.__vr = {
        state, projInfo, classify, lonLatToScene, sceneToLonLat,
        stats: state.stats, veg: state.veg, projCheck
      };
      console.log("window.__vr expuesto:", window.__vr);
    }
    document.getElementById("status").textContent =
      `THREE r${THREE.REVISION} · ${state.cfg.campos.length} campos · ${state.campo.nombre} OK`;
  } catch (err) {
    console.error(err);
    document.getElementById("report").innerHTML =
      `<h1 class="bad">Error en P0/P1</h1><pre>${(err && err.stack) || err}</pre>`;
  }
})();
