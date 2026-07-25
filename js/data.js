/* ============================================================
   data.js — Carga de configuración y datos del campo, SIN MapLibre.
   Extraído del app.js de P1 para que lo compartan la escena 3D
   (index.html) y el reporte de regresión (verify.html).

   Deja listo, en `state`:
     - campo/cfg          entrada de campos.json elegida por ?campo=
     - data.inicial/multi FeatureCollections anotadas con _cls y _sup
     - stats              hectáreas por clase y escenario
     - bbox / center      bbox del campo y su centro (origen de proyección)
     - veg.inicial/multi  árboles + sombras + matas, con las semillas del
                          original (paridad exacta de vegetación, §3.4)
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
  center: null,
  scenario: "inicial",
  growth: { inicial: 1, multi: 0 },
  anim: null
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

/* Extensión del campo en metros de escena (la usan tiles, suelo y cámara) */
function sceneExtent() {
  const [[minLon, minLat], [maxLon, maxLat]] = state.bbox;
  const [x0, z1] = lonLatToScene(minLon, minLat);   // SO → x mínimo, z máximo (z crece al sur)
  const [x1, z0] = lonLatToScene(maxLon, maxLat);   // NE → x máximo, z mínimo
  return { minX: x0, maxX: x1, minZ: z0, maxZ: z1, ancho: x1 - x0, alto: z1 - z0 };
}
