/* ============================================================
   veg-scene.js — Vegetación instanciada: port de vegLayer.buildGroup del
   original (main.js:407-548) a una escena Three.js propia (§9.4).

   Sólo TRES cambios respecto del original:
   1. Las dos llamadas a maplibregl.MercatorCoordinate.fromLngLat (líneas
      430 y 514) → lonLatToScene(). Desaparece la aritmética
      (mc.x - origin.x)/s porque lonLatToScene ya devuelve metros.
   2. Se van this.l, this.scale, this.origin y el renderer compartido con
      MapLibre: acá el renderer es propio de la app.
   3. El reloj del viento lo avanza el loop propio. El comentario del
      original decía "solo anima cuando el mapa repinta ⇒ gratis en
      reposo"; en VR el loop corre siempre, así que el viento cuesta todos
      los frames. Está bien: es un vertex shader trivial.

   TODO lo demás se copia textualmente: geometrías, materiales, offsetHSL,
   lóbulos con probabilidad 0,45, GRASS_SCALE, la variante `alt`, y el
   viento por onBeforeCompile con la uniform uTime compartida.

   El chunking por celda (§9.5) es P3: acá va un InstancedMesh por clase.
   ============================================================ */
"use strict";

/* Geometrías de mata por clase (main.js:558-562) */
const TUFT_GEOS = {};
function buildTuftGeos() {
  for (const [cls, cfg] of Object.entries(GRASS_CLASSES)) {
    TUFT_GEOS[cls] = buildTuftGeometry(4, cfg.tip, cfg.base, cfg.mid, cfg.midCol);
    if (cfg.alt) TUFT_GEOS[cls + "/alt"] = buildTuftGeometry(4, cfg.alt.tip, cfg.alt.base, cfg.alt.mid, cfg.alt.midCol);
  }
}

const Veg = {
  timeUniform: { value: 0 },   // reloj del viento, compartido por todos los materiales
  grupos: {},                  // { inicial: {...}, multi: {...} }

  /* Luces del original (main.js:381-384): con estos valores exactos la
     vegetación se ve como en la app publicada. Sol al norte, sombras
     GeoJSON al sudeste. */
  addLuces(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff3da, 0.85);
    sun.position.set(-0.5, 1, -0.7);
    scene.add(sun);
  },

  build(scene, key) {
    if (!Object.keys(TUFT_GEOS).length) buildTuftGeos();
    const g = this.buildGroup(state.veg[key].trees, state.veg[key].grass);
    g.group.name = "veg-" + key;
    g.group.scale.y = 0.0001;
    this.setGroupOpacity(g, 0);
    scene.add(g.group);
    this.grupos[key] = g;
    return g;
  },

  buildGroup(trees, grass) {
    const group = new THREE.Group();
    const nLobes = trees.reduce((s, t) => s + (t.lobe ? 1 : 0), 0);

    const trunkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 5);
    trunkGeo.translate(0, 0.5, 0); // base del tronco en y=0
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);

    const trunkMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, shininess: 0, transparent: true });
    const crownMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, shininess: 0, transparent: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length + nLobes);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();

    let ci = 0;
    trees.forEach((t, i) => {
      // posición exacta en Mercator -> metros de escena (X este, Z sur)
      const [x, z] = lonLatToScene(t.lon, t.lat);
      const trunkH = t.h * 0.32;
      const trunkR = 0.12 + t.h * 0.035;

      m.compose(
        new THREE.Vector3(x, 0, z),
        q.identity(),
        new THREE.Vector3(trunkR, trunkH, trunkR)
      );
      trunks.setMatrixAt(i, m);
      col.setHex(TRUNK_COLOR).offsetHSL(0, 0, (t.j - 0.5) * 0.08);
      trunks.setColorAt(i, col);

      const sy = t.h * 0.42;
      const cy = trunkH + sy * 0.82;
      eul.set(0, t.j * Math.PI * 2, 0);
      m.compose(
        new THREE.Vector3(x, cy, z),
        q.setFromEuler(eul),
        new THREE.Vector3(t.r, sy, t.r * (0.9 + t.j * 0.2))
      );
      crowns.setMatrixAt(ci, m);
      col.setHex(CROWN_PALETTE[t.c]).offsetHSL(0, 0, (t.j - 0.5) * 0.07);
      crowns.setColorAt(ci, col);
      ci++;

      if (t.lobe) {
        const lr = t.r * 0.6;
        m.compose(
          new THREE.Vector3(x + (t.j - 0.5) * t.r * 1.4, cy + sy * 0.35, z + (((t.j * 7) % 1) - 0.5) * t.r * 1.4),
          q.identity(),
          new THREE.Vector3(lr, lr * 0.9, lr)
        );
        crowns.setMatrixAt(ci, m);
        col.setHex(CROWN_PALETTE[(t.c + 1) % CROWN_PALETTE.length]).offsetHSL(0, 0, (t.j - 0.5) * 0.07);
        crowns.setColorAt(ci, col);
        ci++;
      }
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

    // Los troncos se apoyan sobre el leñoso base (y=0,16) y las matas sobre
    // su fill (y=0,12), según la tabla de §9.3
    const gArb = new THREE.Group(); gArb.position.y = 0.16;
    gArb.add(trunks, crowns);
    group.add(gArb);

    /* Matas de pasto instanciadas: un mesh por clase (cada clase tiene su
       geometría con el color de punta propio); material compartido */
    let grassMat = null;
    const gPasto = new THREE.Group(); gPasto.position.y = 0.12;
    group.add(gPasto);
    if (grass && Object.values(grass).some(t => t.length)) {
      grassMat = new THREE.MeshPhongMaterial({
        color: 0xffffff, flatShading: true, shininess: 0,
        transparent: true, vertexColors: true, side: THREE.DoubleSide
      });
      // Viento: vaivén en shader según la fase por posición de instancia.
      const uTime = this.timeUniform;
      grassMat.onBeforeCompile = sh => {
        sh.uniforms.uTime = uTime;
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uTime;")
          .replace("#include <begin_vertex>",
            "#include <begin_vertex>\n" +
            "float ph = dot(instanceMatrix[3].xz, vec2(37.0, 73.0));\n" +
            "transformed.x += sin(uTime * 1.8 + ph) * 0.12 * position.y;\n" +
            "transformed.z += cos(uTime * 1.3 + ph * 1.7) * 0.08 * position.y;");
      };
      const m2 = new THREE.Matrix4();
      const q2 = new THREE.Quaternion();
      const eul2 = new THREE.Euler();
      const col2 = new THREE.Color();
      for (const [cls, list] of Object.entries(grass)) {
        if (!list.length) continue;
        // Las matas marcadas como variante (sin flor) van en su propio
        // mesh con la geometría alternativa de la clase
        const batches = [[TUFT_GEOS[cls], list.filter(t => !t.v)]];
        if (TUFT_GEOS[cls + "/alt"]) batches.push([TUFT_GEOS[cls + "/alt"], list.filter(t => t.v)]);
        for (const [geo, sub] of batches) {
          if (!sub.length) continue;
          const tufts = new THREE.InstancedMesh(geo, grassMat, sub.length);
          sub.forEach((t, i) => {
            const [x, z] = lonLatToScene(t.lon, t.lat);
            eul2.set(0, t.j * Math.PI * 2, 0);
            m2.compose(
              new THREE.Vector3(x, 0, z),
              q2.setFromEuler(eul2),
              new THREE.Vector3(t.h * 0.9 * GRASS_SCALE, t.h * GRASS_SCALE, t.h * 0.9 * GRASS_SCALE)
            );
            tufts.setMatrixAt(i, m2);
            col2.setHex(t.c).offsetHSL(0, 0, (t.j - 0.5) * 0.09);
            tufts.setColorAt(i, col2);
          });
          tufts.instanceMatrix.needsUpdate = true;
          if (tufts.instanceColor) tufts.instanceColor.needsUpdate = true;
          gPasto.add(tufts);
        }
      }
    }

    return { group, trunkMat, crownMat, grassMat };
  },

  setGroupOpacity(g, o) {
    g.trunkMat.opacity = o;
    g.crownMat.opacity = o;
    if (g.grassMat) g.grassMat.opacity = o;
    g.group.visible = o > 0.02;
  },

  setOpacity(key, o) {
    if (this.grupos[key]) this.setGroupOpacity(this.grupos[key], o);
  },

  setGrowth(key, t) {
    if (this.grupos[key]) this.grupos[key].group.scale.y = Math.max(t, 0.0001);
  },

  /* El reloj del viento lo avanza el loop propio (cambio 3 de arriba).
     En XR habrá que pasarle el `time` de setAnimationLoop en vez de
     performance.now(), para que la fase siga el reloj de la sesión. */
  tick(segundos) { this.timeUniform.value = segundos; },

  info() {
    const out = {};
    for (const [k, g] of Object.entries(this.grupos)) {
      let inst = 0, meshes = 0;
      g.group.traverse(o => { if (o.isInstancedMesh) { inst += o.count; meshes++; } });
      out[k] = { instancias: inst, meshes };
    }
    return out;
  }
};
