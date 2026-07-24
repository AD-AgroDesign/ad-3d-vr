/* ============================================================
   core-veg.js — Generación procedural de vegetación (datos, no render).
   COPIA VERBATIM del proyecto de origen (app/js/main.js:68-104 y
   180-301 del 2026-07-24). Genera atributos de árboles y matas de pasto
   en lon/lat + su geometría unitaria. La COLOCACIÓN en escena (Mercator)
   ocurre después, en veg-scene.js (fase P2).

   Notas de decisiones ganadas con esfuerzo en el proyecto original —
   NO revertir sin pedido explícito (ver HANDOFF_VR.md §12):
   - GRASS_SCALE = 3.6: escala estilizada; una mata real de 1 m es
     invisible a altura de dron. El dueño prefiere que se VEA antes que
     escala real.
   - corr-herb con fila `mid`: confina el lila a la puntita (16 tris);
     variante `alt` sin flor (8 tris) para la mitad de las matas.
   - buildTuftGeometry usa THREE: sólo se invoca en render (P2), no en la
     generación de datos (P1). En la verificación Node se estabiliza THREE.
   ============================================================ */
"use strict";

/* Paleta de copas de monte de espinal */
const CROWN_PALETTE = [0x2a4f22, 0x33602a, 0x3e6d2f, 0x4a7434, 0x567c38, 0x6a7f3e];
const TRUNK_COLOR = 0x5b4632;
const WOODY_BASE = { color: "#2e5026", height: 1.2, opacity: 0.45 };
const HERB_HEIGHT = 0.6;

/* Matas de pasto: corredores herbáceos (pardo) y parches herbáceos
   (verde; el gradiente de vértices les da las puntas doradas).
   Presupuesto por clase: los corredores son los protagonistas y mantienen
   densidad plena; los parches, mucho más extensos, van con tope menor
   (midió 20 fps en el peor caso con tope pleno en ambos).
   OJO VR: IS_MOBILE queda por compatibilidad con el original; en la
   variante VR el presupuesto real lo fija el sistema de tiers (P3, §9.5).
   Para reproducir los conteos del original en P1 se usa el tope de
   ESCRITORIO (IS_MOBILE=false), que es lo que da un navegador de PC. */
const IS_MOBILE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(max-width: 760px)").matches : false;
const GRASS_CLASSES = {
  "corr-herb": {
    // verdes grisáceos con flores lila SOLO en la puntita (ref
    // img/Vista_sobre_corredor.jpg): fila intermedia de vértices a 2/3 de
    // altura, verde hasta ahí y de ahí al lila (hoja de 4 triángulos)
    palette: [0x5a6d48, 0x647952, 0x536a42, 0x6d7f57, 0x4c6240, 0x71835a],
    tip: [2.05, 1.4, 3.1],
    base: [0.62, 0.72, 0.5],
    mid: 0.66,
    midCol: [0.72, 0.82, 0.58],
    // ~la mitad de las matas sin flor: hoja verde de gradiente simple
    // (sin fila intermedia: 8 tris en vez de 16)
    alt: { share: 0.5, tip: [0.9, 1.05, 0.65], base: [0.62, 0.72, 0.5] },
    density: IS_MOBILE ? 1000 : 1500,
    max: IS_MOBILE ? 100000 : 180000
  },
  "parche-herb": {
    palette: [0x5f7a3a, 0x6b8a41, 0x548034, 0x71904a, 0x497029, 0x8a9448],
    tip: [1.25, 1.15, 0.8],   // puntas doradas
    density: IS_MOBILE ? 500 : 800,
    max: IS_MOBILE ? 60000 : 120000
  }
};
/* Escala estilizada: a altura de dron una mata real de 1 m no se lee;
   se exagera igual que el resto de la estética low-poly */
const GRASS_SCALE = 3.6;

/* Scatter determinístico dentro de los polígonos de ciertas clases */
function scatterInClasses(fc, classes, seed, densityPerHa, maxTotal, minPerPoly) {
  const rng = mulberry32(seed);
  const polys = [];
  for (const f of fc.features) {
    if (!classes.includes(f.properties._cls)) continue;
    for (const poly of f.geometry.coordinates) {
      const bbox = ringBBox(poly[0]);
      const ha = ringAreaHa(poly[0], (bbox[1] + bbox[3]) / 2);
      if (ha > 0.003) polys.push({ polygon: poly, bbox, ha });
    }
  }
  const totalHa = polys.reduce((s, p) => s + p.ha, 0);
  const density = Math.min(densityPerHa, maxTotal / Math.max(totalHa, 0.001));
  const points = [];
  for (const wp of polys) {
    const n = Math.max(minPerPoly, Math.round(wp.ha * density));
    const [minX, minY, maxX, maxY] = wp.bbox;
    let placed = 0, attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const pt = [minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)];
      if (!pointInPolygon(pt, wp.polygon)) continue;
      placed++;
      points.push(pt);
    }
  }
  return { points, rng };
}

/* Genera atributos de árboles + sombras drapeadas (GeoJSON) */
function generateTreeData(fc, seed) {
  const { points, rng } = scatterInClasses(fc, WOODY_CLASSES, seed, 55, 4200, 3);
  const trees = [], shadowFeats = [];
  for (const [lon, lat] of points) {
    const h = 5 + rng() * 9;                    // altura total 5–14 m
    const r = h * (0.32 + rng() * 0.2);         // radio de copa proporcional
    trees.push({
      lon, lat, h, r,
      c: Math.floor(rng() * CROWN_PALETTE.length),
      lobe: rng() < 0.45,
      j: rng()
    });
    shadowFeats.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: offsetRing(blobRing(lon, lat, r * 1.15, rng, 7, 0.4), 2.4, -1.8, lat) }
    });
  }
  return { trees, shadows: { type: "FeatureCollection", features: shadowFeats } };
}

/* Puntos de matas de pasto (una pasada por clase, con su paleta;
   la densidad y el tope se aplican por clase) */
function generateGrassData(fc, seed) {
  const byClass = {};
  Object.entries(GRASS_CLASSES).forEach(([cls, cfg], k) => {
    const { points, rng } = scatterInClasses(fc, [cls], seed + k * 977, cfg.density, cfg.max, 2);
    const tufts = [];
    for (const [lon, lat] of points) {
      tufts.push({
        lon, lat,
        h: 0.55 + rng() * 0.75,                     // altura 0,55–1,3 m
        c: cfg.palette[Math.floor(rng() * cfg.palette.length)],
        j: rng(),
        v: cfg.alt && rng() < cfg.alt.share ? 1 : 0 // 1 = variante sin flor
      });
    }
    byClass[cls] = tufts;
  });
  return byClass;
}

/* Geometría unitaria de una mata: 4 hojas inclinadas hacia afuera
   (base y=0, puntas y≈1). Gradiente base → punta vía colores de vértice
   (se multiplican con el color por instancia). Sin `mid`: hoja de 1 quad
   (8 tris/mata). Con `mid` (fracción de altura) se agrega una fila
   intermedia con su color: el de punta queda confinado al tramo superior
   (hoja de 4 tris, 16 tris/mata). REQUIERE THREE (solo en render). */
function buildTuftGeometry(blades = 4, tip = [1.25, 1.15, 0.8], baseCol = [0.5, 0.47, 0.4], mid = null, midCol = null) {
  const pos = [], col = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.9;
    const dx = Math.cos(a), dz = Math.sin(a);
    const bw = 0.1;                                 // media base de la hoja
    const px = -dz * bw, pz = dx * bw;              // perpendicular a la hoja
    const r0 = 0.06, r2 = 0.34;                     // inclinación hacia afuera
    const h2 = 0.9 + ((b * 37) % 12) / 60;
    const v0 = pos.length / 3;
    pos.push(
      dx * r0 - px, 0, dz * r0 - pz, dx * r0 + px, 0, dz * r0 + pz
    );
    col.push(
      baseCol[0], baseCol[1], baseCol[2], baseCol[0], baseCol[1], baseCol[2]
    );
    if (mid) {
      const rm = r0 + (r2 - r0) * mid, hm = h2 * mid, wm = 1 - (1 - 0.22) * mid;
      pos.push(
        dx * rm - px * wm, hm, dz * rm - pz * wm, dx * rm + px * wm, hm, dz * rm + pz * wm
      );
      col.push(
        midCol[0], midCol[1], midCol[2], midCol[0], midCol[1], midCol[2]
      );
      idx.push(v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2);
    }
    const t = pos.length / 3;
    pos.push(
      dx * r2 + px * 0.22, h2, dz * r2 + pz * 0.22, dx * r2 - px * 0.22, h2, dz * r2 - pz * 0.22
    );
    col.push(
      tip[0], tip[1], tip[2], tip[0], tip[1], tip[2]
    );
    // fila previa (base o intermedia) → punta; el orden de la punta está
    // espejado respecto a la fila inferior
    idx.push(t - 2, t - 1, t, t - 2, t, t + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CROWN_PALETTE, TRUNK_COLOR, WOODY_BASE, HERB_HEIGHT,
    IS_MOBILE, GRASS_CLASSES, GRASS_SCALE, scatterInClasses,
    generateTreeData, generateGrassData, buildTuftGeometry };
}
