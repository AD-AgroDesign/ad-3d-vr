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

/* Banda de raleo: en el tramo exterior del radio se dibuja sólo una fracción
   de las instancias de cada celda, en vez de cortar seco.

   Es el pulido que P3 dejó anotado («bajar la densidad en el último tercio del
   radio en vez de cortar seco») y que el dueño pidió al probar en el teléfono
   (2026-07-26): «se notan los cortes cuando el vuelo es alto».

   El truco es que `InstancedMesh.count` se puede bajar y listo: las instancias
   de cada celda están en orden de scatter (aleatorio), así que dibujar las
   primeras N es quedarse con una muestra uniforme de la celda. Cuesta CERO:
   no se recalcula ninguna matriz, no se toca la GPU, y baja los triángulos sin
   cambiar los draw calls.

   El raleo es CONTINUO, no un escalón: un solo umbral se ve como una línea de
   cambio de densidad, que es el mismo problema que se venía a resolver. El
   factor baja suave entre RALEO_DESDE·R y R, y se cuantiza al 10 % para no
   reasignar `count` por nada.

   Y hay un segundo factor, por altura: cuando el radio se abre en vuelo alto,
   la densidad plena en todo ese disco son millones de triángulos (medido en
   P3: 4,8 M desde el aire). A esa altura una mata ocupa menos de un píxel, así
   que se ralea todo el disco en proporción a cuánto se abrió el radio. */
const RALEO_DESDE = 0.55;    // fracción del radio donde empieza el raleo
const RALEO_MIN = 0.35;      // fracción de instancias en el borde del radio
const RALEO_ALT_EXP = 0.6;   // cuánto ralea la apertura del radio por altura

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
    for (const m of meshes) {
      m.frustumCulled = true;
      m.userData.nFull = m.count;      // para poder ralear bajando `count`
    }
    this.celdas[key].push({
      cx, cz, tipo, meshes, hi: hi || null, lo: lo || null,
      visible: true, cerca: true, raleo: 1
    });
  },

  /* El radio se ABRE con la altura.

     El culling por radio parte de que en VR estás DENTRO de la escena
     (§9.5), y ahí un radio fijo es correcto. Pero desde una vista aérea todo
     queda fuera del radio y el campo se ve pelado, sin un solo árbol ni mata
     — que es justo el activo visual del proyecto. Visto en la primera
     medición en vivo: a 900 m de altura, cero celdas visibles.

     La regla es `4 × altura` (era 3 hasta que el dueño probó el vuelo alto en
     el teléfono, 2026-07-26), así que a altura de dron (12–35 m) NO cambia
     nada: 4×18 = 72 m es menos que el radio nominal de cualquier tier, y el
     presupuesto medido a esa altura sigue valiendo tal cual. Sólo se abre
     cuando se sube, y siempre con el tope `radioMax` del tier.

     ⚠️ El factor del escalón se aplica AL FINAL, sobre el radio ya abierto.
     Si se aplicara antes (que es lo que hace Perf.radioMatas()), el
     `Math.max` con la altura lo anularía y la calidad adaptativa degradaría
     hasta el piso SIN NINGÚN EFECTO. Bug visto en vivo: escalón 3 con el
     radio efectivo intacto en 2695 m. */
  radioEfectivo(base, altura) {
    return Math.min(Perf.dial.radioMax, Math.max(base, altura * 4)) * Perf.factorEscalon();
  },
  radioEfectivoMatas() { return this._rPasto || Perf.radioMatas(); },

  /* Revisión de visibilidad. `key` es el escenario activo; el otro se apaga
     entero por opacidad, así que no hace falta recorrerlo. */
  update(camPos, ahora) {
    if (ahora - this._ultimaRevision < REVISAR_CADA) return;
    this._ultimaRevision = ahora;
    const alt = Math.max(0, camPos.y);
    // los radios NOMINALES del tier: el factor del escalón lo aplica
    // radioEfectivo() al final, después de abrir por altura
    const rPasto = this.radioEfectivo(Perf.dial.radioMatas, alt);
    const rArbol = this.radioEfectivo(Perf.dial.radioArboles, alt);
    this._rPasto = rPasto;
    // Cuánto se abrió el radio respecto del nominal del tier: es la medida de
    // cuánta área extra hay que dibujar, y de cuánto se puede ralear sin que
    // se note (a esa altura una mata mide menos de un píxel).
    const escalaAltura = Math.min(1, Math.pow(Perf.dial.radioMatas / Math.max(rPasto, 1), RALEO_ALT_EXP));
    this._escalaAltura = escalaAltura;

    for (const key of ["inicial", "multi"]) {
      for (const c of this.celdas[key]) {
        const dx = c.cx - camPos.x, dz = c.cz - camPos.z;
        const d = Math.hypot(dx, dz);
        const R = c.tipo === "pasto" ? rPasto : rArbol;
        // histéresis: entra a R - banda, sale a R + banda
        const dentro = c.visible ? d < R + BANDA_RADIO : d < R - BANDA_RADIO;
        const cerca = !c.hi ? true
          : (c.cerca ? d < LOD_UMBRAL + BANDA_LOD : d < LOD_UMBRAL - BANDA_LOD);
        // Raleo sólo en el pasto: los árboles son ~100× menos numerosos y son
        // justamente lo que da profundidad, así que no se tocan.
        let raleo = 1;
        if (c.tipo === "pasto" && dentro) {
          const t = (d / R - RALEO_DESDE) / (1 - RALEO_DESDE);
          if (t > 0) raleo = 1 - (1 - RALEO_MIN) * Math.min(1, t);
          raleo *= escalaAltura;
          raleo = Math.max(0.05, Math.round(raleo * 10) / 10);
        }

        if (dentro !== c.visible || cerca !== c.cerca) {
          c.visible = dentro; c.cerca = cerca;
          for (const m of c.meshes) m.visible = dentro;
          // el LOD se reaplica SIEMPRE que se toca la visibilidad: si no, al
          // volver a entrar en radio se encienden las dos copas a la vez
          if (c.hi) { c.hi.visible = dentro && cerca; if (c.lo) c.lo.visible = dentro && !cerca; }
        }
        if (raleo !== c.raleo) {
          c.raleo = raleo;
          for (const m of c.meshes) {
            const n = m.userData.nFull || m.count;
            m.count = raleo >= 1 ? n : Math.max(1, Math.round(n * raleo));
          }
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
