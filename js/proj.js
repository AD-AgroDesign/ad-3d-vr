/* ============================================================
   proj.js — Proyección Web Mercator de la escena (reemplaza a
   maplibregl.MercatorCoordinate). Escena en METROS, convención del
   proyecto de origen: X = este, Y = arriba, Z = sur (diestro).
   Origen: centro del bbox del campo, a altura 0.

   Reproduce BIT A BIT lo que hacía el original con
   MercatorCoordinate.fromLngLat + meterInMercatorCoordinateUnits():
     - EARTH_CIRC = 2π·6371008.8  (idéntico a MapLibre; ≈40075016.686)
     - mercY con log((1+sinφ)/(1-sinφ))/2 = ln(tan(π/4+φ/2)) (Gudermann inv.)
     - metros/unidad = EARTH_CIRC·cos(lat0)  (= 1 / meterInMercatorUnits)

   VERIFICACIÓN CORRECTA (ver corrección en HANDOFF_VR.md §6): comparar
   contra la fórmula de MapLibre da ~0 (epsilon). NO comparar contra el
   método equirectangular kx/ky de core-geom: ese diverge ~0,67% en N-S
   (≈7 m sobre un campo de 2 km) A PROPÓSITO — el original coloca objetos
   con Mercator, no con kx/ky. La diferencia N-S grande es esperada.
   ============================================================ */
"use strict";

const EARTH_CIRC = 2 * Math.PI * 6371008.8;   // = 40075016.6855785 m (MapLibre)

let _origin = { x: 0, y: 0 };   // unidades Mercator normalizadas [0,1] del origen
let _mPerU = 1;                 // metros por unidad Mercator a la latitud del origen
let _lat0 = 0;

function mercFromLngLat(lon, lat) {           // → unidades Mercator normalizadas [0,1]
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: (180 + lon) / 360,
    y: (180 - (180 / Math.PI) * Math.log((1 + s) / (1 - s)) / 2) / 360
  };
}

/* Se fija UNA vez por campo, con lon/lat del centro del bbox. */
function setProjectionOrigin(lon0, lat0) {
  _origin = mercFromLngLat(lon0, lat0);
  _mPerU = EARTH_CIRC * Math.cos(lat0 * Math.PI / 180);
  _lat0 = lat0;
  return { origin: _origin, mPerU: _mPerU };
}

function lonLatToScene(lon, lat) {            // → [x_este_m, z_sur_m]
  const m = mercFromLngLat(lon, lat);
  return [(m.x - _origin.x) * _mPerU, (m.y - _origin.y) * _mPerU];
}

function sceneToLonLat(x, z) {                // → [lon, lat]
  const mx = _origin.x + x / _mPerU, my = _origin.y + z / _mPerU;
  const lon = mx * 360 - 180;
  const n = Math.PI - 2 * Math.PI * my;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

function projInfo() { return { origin: _origin, mPerU: _mPerU, lat0: _lat0 }; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { EARTH_CIRC, mercFromLngLat, setProjectionOrigin,
    lonLatToScene, sceneToLonLat, projInfo };
}
