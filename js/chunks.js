/* ============================================================
   chunks.js — Grilla espacial, culling por radio y LOD (§9.5).

   El insight que hace viable todo esto: hoy la app dibuja el campo entero
   desde el aire (~300 k matas, millones de triángulos). En VR estás DENTRO
   de la escena y sólo necesitás pasto cerca. El culling por radio no es una
   degradación: es una mejora.

   Cómo funciona:
   - Grilla de 64 m para matas y 128 m para árboles. veg-scene.js reparte
     las instancias por celda y registra acá cada mesh con su centro.
   - Three hace frustum culling por mesh gratis vía boundingSphere — se fija
     A MANO (centro de la celda, radio = semidiagonal + altura máxima),
     porque computeBoundingSphere() sobre un InstancedMesh sólo mira la
     geometría base, no las matrices de instancia.
   - Culling por radio: `visible = dist < R`. Alcanza con revisarlo cada
     200 ms; hacerlo por frame no cambia nada y cuesta.
   - LOD de copas: dos meshes por celda de árboles, icosaedro nivel 1
     (80 tris) cerca y nivel 0 (20 tris) lejos.

   Histéresis en los dos umbrales (radio y LOD). Es la lección §12.5: un
   umbral pelado parpadea cuando la cámara queda justo en el borde.
   ============================================================ */
"use strict";

const GRID_PASTO = 64;
const GRID_ARBOL = 128;
const LOD_UMBRAL = 150;      // m: de acá para allá, copas de 20 tris
const BANDA_LOD = 25;        // m de histéresis del LOD
const BANDA_RADIO = 15;      // m de histéresis del culling por radio
const REVISAR_CADA = 200;    // ms

const Chunks = {
  /* Una entrada por celda: { cx, cz, tipo, meshes[], hi, lo, visible, cerca } */
  celdas: { inicial: [], multi: [] },
  _ultimaRevision: 0,

  claveCelda(x, z, grid) { return Math.floor(x / grid) + "|" + Math.floor(z / grid); },
  centroCelda(clave, grid) {
    const [i, j] = clave.split("|").map(Number);
    return [(i + 0.5) * grid, (j + 0.5) * grid];
  },

  reset(key) { this.celdas[key] = []; },

  /* Geometría por celda que COMPARTE los buffers de atributos con la base y
     sólo se diferencia en el boundingSphere.

     Hace falta porque en r149 el frustum culling mira
     `geometry.boundingSphere` transformado por la matrixWorld del mesh, y
     NO las matrices de instancia. Con la geometría compartida entre celdas,
     todas tendrían la misma esfera y el culling daría cualquier cosa.
     Como los BufferAttribute son los mismos objetos, Three reusa los buffers
     de GPU (los cachea por atributo, no por geometría): el costo real es un
     VAO por celda, no una copia de los vértices.

     Las instancias se guardan RELATIVAS al centro de la celda y el mesh se
     posiciona en ese centro, así la esfera queda centrada en el origen de
     la geometría. */
  geoParaCelda(base, radio, alturaMax) {
    const g = new THREE.BufferGeometry();
    for (const nombre of Object.keys(base.attributes)) g.setAttribute(nombre, base.attributes[nombre]);
    if (base.index) g.setIndex(base.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, alturaMax / 2, 0), radio);
    return g;
  },

  radioCelda(grid, alturaMax) { return Math.SQRT2 * grid / 2 + alturaMax; },

  /* tipo: "pasto" | "arbol". `lo` es opcional (sólo copas). */
  registrar(key, { cx, cz, tipo, meshes, hi, lo }) {
    for (const m of meshes) m.frustumCulled = true;
    this.celdas[key].push({ cx, cz, tipo, meshes, hi: hi || null, lo: lo || null, visible: true, cerca: true });
  },

  /* Revisión de visibilidad. `key` es el escenario activo; el otro se apaga
     entero por opacidad, así que no hace falta recorrerlo. */
  update(camPos, ahora) {
    if (ahora - this._ultimaRevision < REVISAR_CADA) return;
    this._ultimaRevision = ahora;
    const rPasto = Perf.radioMatas(), rArbol = Perf.radioArboles();

    for (const key of ["inicial", "multi"]) {
      for (const c of this.celdas[key]) {
        const dx = c.cx - camPos.x, dz = c.cz - camPos.z;
        const d = Math.hypot(dx, dz);
        const R = c.tipo === "pasto" ? rPasto : rArbol;
        // histéresis: entra a R - banda, sale a R + banda
        const dentro = c.visible ? d < R + BANDA_RADIO : d < R - BANDA_RADIO;
        const cerca = !c.hi ? true
          : (c.cerca ? d < LOD_UMBRAL + BANDA_LOD : d < LOD_UMBRAL - BANDA_LOD);
        if (dentro !== c.visible || cerca !== c.cerca) {
          c.visible = dentro; c.cerca = cerca;
          for (const m of c.meshes) m.visible = dentro;
          // el LOD se reaplica SIEMPRE que se toca la visibilidad: si no, al
          // volver a entrar en radio se encienden las dos copas a la vez
          if (c.hi) { c.hi.visible = dentro && cerca; if (c.lo) c.lo.visible = dentro && !cerca; }
        }
      }
    }
  },

  /* Fuerza una revisión en el próximo update (al cambiar de escalón o al
     teletransportar el rig, donde esperar 200 ms se nota) */
  invalidar() { this._ultimaRevision = 0; },

  info() {
    const out = {};
    for (const key of ["inicial", "multi"]) {
      const cs = this.celdas[key];
      out[key] = {
        celdas: cs.length,
        pasto: cs.filter(c => c.tipo === "pasto").length,
        arboles: cs.filter(c => c.tipo === "arbol").length,
        visibles: cs.filter(c => c.visible).length,
        meshes: cs.reduce((s, c) => s + c.meshes.length, 0)
      };
    }
    return out;
  }
};
