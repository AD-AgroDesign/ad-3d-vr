/* ============================================================
   tiles.js — Suelo satelital sin MapLibre: descarga de tiles de Esri y
   armado de atlas de textura (§9.1).

   Fuente (la misma del original, main.js:331):
     .../World_Imagery/MapServer/tile/{z}/{y}/{x}
   ⚠️ ArcGIS ordena nivel/FILA/COLUMNA. Con x antes que y se reciben
   imágenes de otro lugar del planeta.

   Atribución obligatoria y visible en la app:
     Imagen satelital © Esri, Maxar, Earthstar Geographics | AgroDesign

   Por qué atlas y no un mesh por tile: 100–361 tiles serían 100–361 draw
   calls. Dibujados en canvases de hasta 2048×2048 (8×8 tiles) quedan unos
   pocos planos. Los atlas del borde se recortan al tamaño real de los
   tiles que contienen, para no desperdiciar VRAM.

   Niveles nativos (verificado en el proyecto original): Esri no tiene
   imagen más allá de z17 en Silesia y Carmen, ni de z18 en Monte Hermoso.
   Más allá devuelve un relleno gris de exactamente 2521 bytes. Por eso se
   descarga por fetch (que sí expone el tamaño) y, si demasiados tiles son
   placeholder, se reintenta un nivel más abajo.
   ============================================================ */
"use strict";

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
const TILE_PX = 256;
const ATLAS_TILES = 8;             // 8×8 tiles = 2048 px por atlas
const TILE_PLACEHOLDER_BYTES = 2521;
const MAX_TILES = 800;             // freno de mano: baja el zoom antes de pedir más
const CONCURRENCIA = 6;

const Tiles = {
  atlases: [],   // [{ texture, minX, maxX, minZ, maxZ }] en metros de escena
  info: null,

  /* margenM: cuánto se extiende la cobertura más allá del bbox del campo */
  async load(bboxLonLat, zoomPedido, { margenM = 400, onProgress = null } = {}) {
    const { origin, mPerU } = projInfo();
    const [[minLon, minLat], [maxLon, maxLat]] = bboxLonLat;
    const margen = margenM / mPerU;
    const a = mercFromLngLat(minLon, maxLat);   // NO → x mín, y mín
    const b = mercFromLngLat(maxLon, minLat);   // SE → x máx, y máx
    const mx0 = a.x - margen, my0 = a.y - margen;
    const mx1 = b.x + margen, my1 = b.y + margen;

    let z = zoomPedido;
    let rango = this._rango(z, mx0, my0, mx1, my1);
    while (rango.total > MAX_TILES && z > 12) {   // demasiados tiles: bajar nivel
      z--; rango = this._rango(z, mx0, my0, mx1, my1);
    }

    let intento = 0, res;
    while (true) {
      res = await this._descargar(z, rango, onProgress);
      const fraccion = res.placeholder / Math.max(1, res.total);
      // Más de un quinto de tiles grises ⇒ Esri no tiene imagen a este nivel
      if (fraccion <= 0.2 || z <= 13 || intento >= 2) break;
      console.warn(`tiles: ${res.placeholder}/${res.total} sin imagen en z${z}; reintento en z${z - 1}`);
      z--; rango = this._rango(z, mx0, my0, mx1, my1); intento++;
    }

    this.atlases = this._atlas(z, rango, res.imgs, origin, mPerU);
    // Resumen chico a propósito: `res` trae las imágenes decodificadas y la
    // lista de pedidos, que no tienen por qué salir por consola ni por __vr
    this.info = {
      z, col0: rango.col0, row0: rango.row0, cols: rango.cols, rows: rango.rows,
      total: res.total, placeholder: res.placeholder, fail: res.fail,
      atlases: this.atlases.length
    };
    return this.info;
  },

  _rango(z, mx0, my0, mx1, my1) {
    const n = Math.pow(2, z);
    const clamp = v => Math.max(0, Math.min(n - 1, v));
    const col0 = clamp(Math.floor(mx0 * n)), col1 = clamp(Math.floor(mx1 * n));
    const row0 = clamp(Math.floor(my0 * n)), row1 = clamp(Math.floor(my1 * n));
    const cols = col1 - col0 + 1, rows = row1 - row0 + 1;
    return { col0, row0, cols, rows, total: cols * rows };
  },

  async _descargar(z, rango, onProgress) {
    const pedidos = [];
    for (let r = 0; r < rango.rows; r++)
      for (let c = 0; c < rango.cols; c++)
        pedidos.push({ c, r, col: rango.col0 + c, row: rango.row0 + r });

    const imgs = new Array(pedidos.length).fill(null);
    let cursor = 0, hechos = 0, placeholder = 0, fail = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= pedidos.length) return;
        const p = pedidos[i];
        try {
          // fetch (no <img>) para poder ver el tamaño: así se detecta el
          // relleno gris "Map data not yet available" de 2521 bytes
          const resp = await fetch(`${TILE_URL}/${z}/${p.row}/${p.col}`);
          if (!resp.ok) throw new Error(resp.status);
          const blob = await resp.blob();
          if (blob.size === TILE_PLACEHOLDER_BYTES) {
            // relleno gris de Esri: NO se dibuja, o el cartel "Map data not
            // yet available" aparece como manchones claros en el borde.
            // ⚠️ La comparación es EXACTA a propósito: con un umbral (<2,5 KB)
            // se descartan tiles legítimos, porque un lote agrícola uniforme
            // comprime a menos de eso en JPEG. Costó una ronda de capturas.
            placeholder++;
          } else {
            imgs[i] = await this._decodificar(blob);
          }
        } catch (e) {
          fail++;
        }
        hechos++;
        if (onProgress) onProgress(hechos, pedidos.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCIA }, worker));
    return { imgs, pedidos, total: pedidos.length, placeholder, fail };
  },

  async _decodificar(blob) {
    if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = e => { URL.revokeObjectURL(url); rej(e); };
      im.src = url;
    });
  },

  /* Agrupa los tiles en bloques de hasta 8×8 y arma una textura por bloque.
     La extensión de cada atlas se calcula en Mercator y se pasa a metros de
     escena con (m - origin) · mPerU: satélite y polígonos quedan alineados
     por construcción, sin pasar por lon/lat. */
  _atlas(z, rango, imgs, origin, mPerU) {
    const n = Math.pow(2, z);
    const out = [];
    for (let br = 0; br < rango.rows; br += ATLAS_TILES) {
      for (let bc = 0; bc < rango.cols; bc += ATLAS_TILES) {
        const nc = Math.min(ATLAS_TILES, rango.cols - bc);
        const nr = Math.min(ATLAS_TILES, rango.rows - br);
        const cv = document.createElement("canvas");
        cv.width = nc * TILE_PX; cv.height = nr * TILE_PX;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#8d9481";               // color de tierra si falta un tile
        ctx.fillRect(0, 0, cv.width, cv.height);
        for (let r = 0; r < nr; r++) {
          for (let c = 0; c < nc; c++) {
            const im = imgs[(br + r) * rango.cols + (bc + c)];
            if (im) ctx.drawImage(im, c * TILE_PX, r * TILE_PX, TILE_PX, TILE_PX);
          }
        }
        const tex = new THREE.CanvasTexture(cv);
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 4;
        tex.needsUpdate = true;

        const mxA = (rango.col0 + bc) / n, mxB = (rango.col0 + bc + nc) / n;
        const myA = (rango.row0 + br) / n, myB = (rango.row0 + br + nr) / n;
        out.push({
          texture: tex,
          minX: (mxA - origin.x) * mPerU, maxX: (mxB - origin.x) * mPerU,
          minZ: (myA - origin.y) * mPerU, maxZ: (myB - origin.y) * mPerU   // z crece al sur
        });
      }
    }
    return out;
  },

  /* Libera las texturas (cambio de campo / de nivel) */
  dispose() {
    for (const a of this.atlases) a.texture.dispose();
    this.atlases = [];
  }
};
