/* ============================================================
   core-route.js — Rutas de vuelo del tour (eje de corredor + perfil de
   velocidad). COPIA VERBATIM del proyecto de origen (app/js/main.js:
   906-1034 del 2026-07-24). Trabajan en lon/lat con métrica local kx/ky;
   devuelven lon/lat. En VR (P6) se consumen convirtiendo la salida con
   lonLatToScene y moviendo el RIG, no la cámara. NO recalibrar CRUISE/
   RATE/VMIN ni el amortiguado: fue aprobado como "resultado perfecto".
   ============================================================ */
"use strict";

/* Eje central aproximado de un corredor (polígono alargado): vértices del
   anillo exterior proyectados sobre el eje principal (PCA) y promediados
   por franjas. Sirve de ruta para el vuelo rasante que sigue el recorrido. */
function corridorCenterline(feature) {
  let ring = null, bestA = 0;
  for (const poly of feature.geometry.coordinates) {
    const r = poly && poly[0];
    if (!r || r.length < 4) continue;
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a = Math.abs(a);
    if (a > bestA) { bestA = a; ring = r; }
  }
  if (!ring) return null;
  const kx = 111320 * Math.cos(ring[0][1] * Math.PI / 180), ky = 110540;  // grados → m
  const pts = ring.map(([x, y]) => [x * kx, y * ky]);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const proj = pts.map(([x, y]) => [(x - cx) * ux + (y - cy) * uy, x, y]);
  let tMin = Infinity, tMax = -Infinity;
  for (const [t] of proj) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
  const span = tMax - tMin;
  if (span < 300) return null;                       // muy corto para un rasante
  const bins = Math.max(8, Math.min(40, Math.round(span / 80)));
  const acc = Array.from({ length: bins }, () => [0, 0, 0]);
  for (const [t, x, y] of proj) {
    const b = Math.min(bins - 1, Math.floor(((t - tMin) / span) * bins));
    acc[b][0] += x; acc[b][1] += y; acc[b][2]++;
  }
  let line = acc.filter(a => a[2]).map(a => [a[0] / a[2], a[1] / a[2]]);
  if (line.length < 2) return null;
  for (let pass = 0; pass < 2; pass++) {             // doble media móvil de 3
    line = line.map((p, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      return [(a[0] + p[0] + b[0]) / 3, (a[1] + p[1] + b[1]) / 3];
    });
  }
  let lenM = 0;
  for (let i = 1; i < line.length; i++) lenM += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return { path: line.map(([x, y]) => [x / kx, y / ky]), lenM };
}

/* Ruta densificada con spline Catmull-Rom en espacio métrico: convierte la
   polilínea del eje (vértices cada ~80 m, quiebre en cada uno) en una curva
   continua muestreada cada pocos metros. */
function densifyPath(path, stepM = 8) {
  const kx = 111320 * Math.cos(path[0][1] * Math.PI / 180), ky = 110540;
  const pts = path.map(([x, y]) => [x * kx, y * ky]);
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return [
      0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3)
    ];
  };
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / stepM));
    for (let k = 0; k < n; k++) out.push(cr(p0, p1, p2, p3, k / n));
  }
  out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [x / kx, y / ky]);
}

/* Pose de crucero del rasante (referencia de MapLibre): en VR NO se usa el
   zoom/pitch — se elige una ALTURA de vuelo (ver HANDOFF_VR.md §9.12). */
const RAZANTE_CAM = { zoom: 17.25, pitch: 76 };

/* Geometría del rasante precalculada: posición y rumbo continuos por
   distancia a lo largo de la ruta suavizada. */
function makeFlight(rawPath) {
  const path = densifyPath(rawPath);
  const kx = 111320 * Math.cos(path[0][1] * Math.PI / 180), ky = 110540;
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * kx, (path[i][1] - path[i - 1][1]) * ky));
  }
  const total = cum[cum.length - 1];
  const at = d => {
    d = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const f = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
    return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f,
            path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
  };
  const bearingAt = d => {
    const a = at(d - 20), b = at(d + 50);            // leve anticipación de la curva
    return Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) * 180 / Math.PI;
  };
  /* Perfil de velocidad por curvatura: como un dron real, frena en las
     curvas para que el paneo nunca sea un latigazo. Se limita la tasa de
     giro a ~RATE °/s bajando la velocidad donde el eje dobla fuerte. */
  const CRUISE = 75, RATE = 28, VMIN = 20;           // m/s, °/s, m/s
  let curv = path.map((_, i) => {
    if (i === 0 || i === path.length - 1) return 0;
    const b1 = Math.atan2((path[i][0] - path[i - 1][0]) * kx, (path[i][1] - path[i - 1][1]) * ky);
    const b2 = Math.atan2((path[i + 1][0] - path[i][0]) * kx, (path[i + 1][1] - path[i][1]) * ky);
    const db = Math.abs((((b2 - b1) * 180 / Math.PI) % 360 + 540) % 360 - 180);
    return db / Math.max((cum[i + 1] - cum[i - 1]) / 2, 1e-6);   // °/m
  });
  curv = curv.map((_, i) => {                        // suavizado ±5 muestras (~40 m)
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 5); k <= Math.min(curv.length - 1, i + 5); k++) { s += curv[k]; n++; }
    return s / n;
  });
  const spd = curv.map(c => Math.max(VMIN, Math.min(CRUISE, RATE / Math.max(c, 1e-6))));
  const tcum = [0];
  for (let i = 1; i < path.length; i++) {
    tcum.push(tcum[i - 1] + (cum[i] - cum[i - 1]) * 2 / (spd[i - 1] + spd[i]));
  }
  const timeTotal = tcum[tcum.length - 1];           // segundos a velocidad real
  const distAtTime = tau => {
    tau = Math.max(0, Math.min(timeTotal, tau));
    let i = 1;
    while (i < tcum.length - 1 && tcum[i] < tau) i++;
    const f = (tau - tcum[i - 1]) / Math.max(tcum[i] - tcum[i - 1], 1e-9);
    return cum[i - 1] + (cum[i] - cum[i - 1]) * f;
  };
  return { at, bearingAt, total, timeTotal, distAtTime };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { corridorCenterline, densifyPath, RAZANTE_CAM, makeFlight };
}
