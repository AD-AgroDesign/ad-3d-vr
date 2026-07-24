/* ============================================================
   core-geom.js — Utilidades geométricas puras (sin dependencias).
   COPIA VERBATIM del proyecto de origen (app/js/main.js:107-177 del
   2026-07-24). Trabajan en lon/lat (grados) con conversiones locales
   kx/ky para áreas; NO usan la proyección Mercator de escena (proj.js).
   OJO: ky=110574 es equirectangular local — para COLOCAR objetos en la
   escena se usa lonLatToScene (Mercator exacto), no estas kx/ky. Ver §6.
   ============================================================ */
"use strict";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(pt, polygon[i])) return false;
  return true;
}

function ringAreaHa(ring, latRef) {
  const kx = 111320 * Math.cos((latRef * Math.PI) / 180), ky = 110574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(a / 2) / 10000;
}

function featureCentroid(feature) {
  let best = null, bestArea = -1;
  for (const poly of feature.geometry.coordinates) {
    const a = ringAreaHa(poly[0], poly[0][0][1]);
    if (a > bestArea) { bestArea = a; best = poly[0]; }
  }
  let sx = 0, sy = 0;
  for (const [x, y] of best) { sx += x; sy += y; }
  return [sx / best.length, sy / best.length];
}

function blobRing(lon, lat, rMeters, rng, verts = 7, jitter = 0.5) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  const ring = [];
  const rot = rng() * Math.PI * 2;
  for (let i = 0; i < verts; i++) {
    const ang = rot + (i * Math.PI * 2) / verts;
    const r = rMeters * (1 - jitter / 2 + rng() * jitter);
    ring.push([lon + (Math.cos(ang) * r) / kx, lat + (Math.sin(ang) * r) / ky]);
  }
  ring.push(ring[0]);
  return [ring];
}

function offsetRing(polygon, dxM, dyM, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  return [polygon[0].map(([x, y]) => [x + dxM / kx, y + dyM / ky])];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { mulberry32, ringBBox, pointInRing, pointInPolygon,
    ringAreaHa, featureCentroid, blobRing, offsetRing };
}
