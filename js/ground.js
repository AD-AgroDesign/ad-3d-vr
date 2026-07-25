/* ============================================================
   ground.js — El suelo: satélite (atlas de tiles) + polígonos de clase
   triangulados + sombras de árboles (§9.2 y §9.3).

   Reemplaza las capas fill / line / fill-extrusion de MapLibre
   (main.js:666-753) y los valores calibrados de SCENARIO_LAYERS
   (main.js:755-775). Los colores y opacidades de acá son ESOS valores:
   están calibrados con el dueño, no se tocan sin pedido.

   Dos decisiones que importan:
   - Las extrusiones del original son de altura 0–1,2 m (HANDOFF §3.2): lo
     que MapLibre aportaba visualmente es un suelo plano texturizado. Por
     eso acá todo es plano y el crecimiento (applyGrowth) sólo afecta a la
     vegetación, que es donde se ve.
   - Todo lo plano es coplanar en el original (MapLibre ordena por capas).
     Acá se separa en Y según la tabla de §9.3 y además se fija renderOrder
     creciente; los overlays van con depthWrite:false y polygonOffset, así
     que el orden es determinístico y no hay z-fighting contra el satélite.
   ============================================================ */
"use strict";

/* Orden en Y de §9.3. Cada entrada es una capa fusionada por escenario. */
const CAPAS_SUELO = [
  { id: "zona-fill", solo: "multi", y: 0.040, ro: 10, tipo: "fill",
    clases: ["zona1", "zona2", "zona3"],
    colores: { zona1: "#2e7d32", zona2: "#66bb6a", zona3: "#9ccc65" }, on: 0.18 },
  { id: "zona-line", solo: "multi", y: 0.045, ro: 11, tipo: "line",
    clases: ["zona1", "zona2", "zona3"],
    colores: { zona1: "#7ddf8a", zona2: "#a8e6a0", zona3: "#c8eeb0" }, on: 0.85 },
  { id: "agri-line", solo: "inicial", y: 0.045, ro: 11, tipo: "line",
    clases: ["agri"], color: "#f3eecb", on: 0.55 },
  { id: "otros-fill", y: 0.040, ro: 12, tipo: "fill",
    clases: MISC_CLASSES, color: "#c9c9b8", on: 0.06 },
  { id: "otros-line", y: 0.045, ro: 13, tipo: "line", dash: true,
    clases: MISC_CLASSES, color: "#e8e6d5", on: 0.5 },
  { id: "herb-color", y: 0.080, ro: 14, tipo: "fill",
    clases: HERB_LIKE_CLASSES,
    colores: { "corr-herb": "#6b5d38", "parche-herb": "#4d5c33", "bajo": "#6f8a72" },
    color: "#6d8050", on: 0.9 },
  { id: "herb-tex", y: 0.120, ro: 15, tipo: "textura",
    texturas: { "corr-herb": "img/pastizal-pardo.jpg", "parche-herb": "img/pastizal-verde.jpg" },
    textura: "img/pastizal.jpg", clases: HERB_LIKE_CLASSES, on: 0.75 },
  { id: "woody-base", y: 0.160, ro: 16, tipo: "fill",
    clases: ["parche-le", "corr-le"], color: WOODY_BASE.color, on: WOODY_BASE.opacity },
  { id: "sombras", y: 0.200, ro: 17, tipo: "sombras", color: "#0c1c08", on: 0.28 }
];

/* Una repetición de la textura de pastizal cada 8 m. Es un dial visual
   (§9.2): se ajusta mirando, no calculando. */
const PASTIZAL_M = 8;

const Ground = {
  satelite: null,
  fondo: null,
  escenarios: { inicial: null, multi: null },   // { grupo, capas:[{mesh, on}] }

  /* ---------- Satélite: un quad por atlas ----------
     `fondo` arma la capa de respaldo de bajo zoom que extiende el mundo
     decenas de km (§9.6: la niebla tiene que cerrar ANTES de que se vea el
     borde del suelo; con un fondo grande el borde nunca entra en cuadro).
     Va sin depth: se dibuja antes que el satélite de detalle y éste la tapa
     por orden, no por profundidad — a esa distancia el depth buffer no
     distingue centímetros y saldrían franjas. */
  buildSatelite(scene, atlases, { fondo = false } = {}) {
    const g = new THREE.Group();
    g.name = fondo ? "satelite-fondo" : "satelite";
    for (const a of atlases) {
      // Quad a mano en (x, 0, z) con UVs explícitas: nada de PlaneGeometry
      // rotada, para no razonar sobre el flip de Z (§9.2). Con flipY por
      // defecto en la textura, v=1 es el tope del canvas = el norte = minZ.
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([
        a.minX, 0, a.minZ, a.maxX, 0, a.minZ, a.maxX, 0, a.maxZ, a.minX, 0, a.maxZ
      ], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      // Winding antihorario visto DESDE ARRIBA: recorriendo +X y después +Z
      // la normal por winding sale hacia -Y (x̂ × ẑ = -ŷ) y el back-face
      // culling se come el suelo entero. Por eso el orden va invertido.
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: a.texture,
        depthTest: !fondo, depthWrite: !fondo
      }));
      mesh.renderOrder = fondo ? -40 : 0;
      g.add(mesh);
    }
    scene.add(g);
    if (fondo) this.fondo = g; else this.satelite = g;
    return g;
  },

  /* ---------- Polígonos de clase ---------- */
  buildEscenario(scene, key) {
    const fc = state.data[key === "inicial" ? "inicial" : "multi"];
    const grupo = new THREE.Group();
    grupo.name = "suelo-" + key;
    // Desempate determinístico entre los dos escenarios mientras dura el
    // cross-fade: mismo layout, 1 cm de separación y renderOrder desplazado
    const dz = key === "multi" ? 0.01 : 0;
    const roBase = key === "multi" ? 100 : 0;
    const capas = [];

    for (const def of CAPAS_SUELO) {
      if (def.solo && def.solo !== key) continue;
      const hechas = def.tipo === "sombras" ? this._sombras(fc, def, key)
        : def.tipo === "line" ? this._lineas(fc, def)
        : def.tipo === "textura" ? this._texturas(fc, def)
        : [this._relleno(fc, def)];
      for (const obj of hechas) {
        if (!obj) continue;
        obj.position.y = def.y + dz;
        obj.renderOrder = roBase + def.ro;
        obj.material.opacity = 0;
        obj.visible = false;
        grupo.add(obj);
        capas.push({ mesh: obj, on: def.on, id: def.id });
      }
    }
    scene.add(grupo);
    this.escenarios[key] = { grupo, capas };
    return this.escenarios[key];
  },

  /* --- Relleno fusionado (un mesh para todas las clases del grupo) --- */
  _relleno(fc, def) {
    const sink = { pos: [], col: [], idx: [] };
    const col = new THREE.Color();
    for (const f of fc.features) {
      const cls = f.properties._cls;
      if (!def.clases.includes(cls)) continue;
      col.set((def.colores && def.colores[cls]) || def.color);
      for (const poly of f.geometry.coordinates) triangulaPoly(poly, sink, col);
    }
    if (!sink.idx.length) return null;
    const geo = geoDe(sink, true);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    }));
  },

  /* --- Textura de pastizal: un mesh por textura (3 como mucho) --- */
  _texturas(fc, def) {
    const porTex = {};
    for (const f of fc.features) {
      const cls = f.properties._cls;
      if (!def.clases.includes(cls)) continue;
      const url = def.texturas[cls] || def.textura;
      const sink = porTex[url] || (porTex[url] = { pos: [], col: [], idx: [], uv: [] });
      for (const poly of f.geometry.coordinates) triangulaPoly(poly, sink, null, PASTIZAL_M);
    }
    const out = [];
    for (const [url, sink] of Object.entries(porTex)) {
      if (!sink.idx.length) continue;
      const tex = texturaRepetida(url);
      out.push(new THREE.Mesh(geoDe(sink, false), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      })));
    }
    return out;
  },

  /* --- Líneas de contorno (reemplazan las capas `line` de MapLibre) --- */
  _lineas(fc, def) {
    const pos = [], colors = [];
    const col = new THREE.Color();
    for (const f of fc.features) {
      const cls = f.properties._cls;
      if (!def.clases.includes(cls)) continue;
      col.set((def.colores && def.colores[cls]) || def.color);
      for (const poly of f.geometry.coordinates) {
        for (const ring of poly) {
          const pts = anilloEscena(ring);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            pos.push(a.x, 0, a.y, b.x, 0, b.y);
            colors.push(col.r, col.g, col.b, col.r, col.g, col.b);
          }
        }
      }
    }
    if (!pos.length) return [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const matOpts = { vertexColors: true, transparent: true, opacity: 0, depthWrite: false };
    let mat;
    if (def.dash) {
      // equivalente al line-dasharray [2.5, 2] del original, en metros
      mat = new THREE.LineDashedMaterial({ ...matOpts, dashSize: 7, gapSize: 5.5 });
    } else {
      mat = new THREE.LineBasicMaterial(matOpts);
    }
    const l = new THREE.LineSegments(geo, mat);
    if (def.dash) l.computeLineDistances();
    return [l];
  },

  /* --- Sombras de árboles: blobs de 7 vértices fusionados en un mesh --- */
  _sombras(fc, def, key) {
    const sink = { pos: [], col: [], idx: [] };
    const col = new THREE.Color(def.color);
    for (const f of state.veg[key].shadows.features) {
      triangulaPoly(f.geometry.coordinates, sink, col);
    }
    if (!sink.idx.length) return [];
    return [new THREE.Mesh(geoDe(sink, true), new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    }))];
  },

  /* Opacidad de todas las capas planas de un escenario, escalada por su
     valor `on` calibrado (equivalente a applyOpacity de main.js:786) */
  setOpacidad(key, t) {
    const e = this.escenarios[key];
    if (!e) return;
    for (const c of e.capas) {
      c.mesh.material.opacity = c.on * t;
      c.mesh.visible = c.mesh.material.opacity > 0.004;
    }
  },

  info() {
    const n = {};
    for (const k of ["inicial", "multi"]) n[k] = this.escenarios[k] ? this.escenarios[k].capas.length : 0;
    return {
      capas: n,
      atlases: this.satelite ? this.satelite.children.length : 0,
      atlasesFondo: this.fondo ? this.fondo.children.length : 0
    };
  }
};

/* ---------- Helpers de triangulación ---------- */

/* Anillo lon/lat → Vector2 en metros de escena (x, z), sin el vértice
   repetido de cierre: earcut lo tolera pero genera triángulos degenerados */
function anilloEscena(ring) {
  const n = ring.length;
  let m = n;
  if (n > 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) m = n - 1;
  const out = new Array(m);
  for (let i = 0; i < m; i++) {
    const p = lonLatToScene(ring[i][0], ring[i][1]);
    out[i] = new THREE.Vector2(p[0], p[1]);
  }
  return out;
}

/* Un polígono GeoJSON (contorno + agujeros) → triángulos en el sink.
   Si `uvM` viene, se agregan UVs en metros para las texturas de pastizal. */
function triangulaPoly(poly, sink, color, uvM) {
  const contour = anilloEscena(poly[0]);
  if (contour.length < 3) return;
  const holes = [];
  for (let i = 1; i < poly.length; i++) {
    const h = anilloEscena(poly[i]);
    if (h.length >= 3) holes.push(h);
  }
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch (e) {
    return;   // polígono degenerado (deuda de datos conocida, §3.5): se saltea
  }
  const verts = holes.length ? contour.concat(...holes) : contour;
  const base = sink.pos.length / 3;
  for (const v of verts) {
    sink.pos.push(v.x, 0, v.y);
    if (color) sink.col.push(color.r, color.g, color.b);
    if (uvM) sink.uv.push(v.x / uvM, -v.y / uvM);
  }
  for (const f of faces) sink.idx.push(base + f[0], base + f[1], base + f[2]);
}

/* BufferGeometry desde el sink. Las normales se escriben a mano como
   (0,1,0): son planos horizontales, es más rápido que computeVertexNormals
   y evita que un winding invertido dé una cara negra (§9.2). */
function geoDe(sink, conColor) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(sink.pos, 3));
  const nv = sink.pos.length / 3;
  const nor = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) nor[i * 3 + 1] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  if (conColor) geo.setAttribute("color", new THREE.Float32BufferAttribute(sink.col, 3));
  if (sink.uv && sink.uv.length) geo.setAttribute("uv", new THREE.Float32BufferAttribute(sink.uv, 2));
  geo.setIndex(sink.idx);
  geo.computeBoundingSphere();
  return geo;
}

const _texCache = {};
function texturaRepetida(url) {
  if (_texCache[url]) return _texCache[url];
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _texCache[url] = t;
  return t;
}
