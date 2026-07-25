/* ============================================================
   app.js — Orquestación de la escena (P2).

   Arma el renderer, la escena y el rig; carga el campo (data.js), baja el
   satélite (tiles.js), construye el suelo (ground.js) y la vegetación
   (veg-scene.js), y arranca el driver de display. La conmutación de
   escenario es el port de setScenario del original (main.js:795-826).

   Query string, con la misma semántica del proyecto de origen:
     ?campo=<id>   campo a cargar          ?debug   expone window.__vr
     ?fps          HUD de medición         ?z=<n>   fuerza el zoom del atlas
     ?alt=<m>      altura inicial del ojo  ?sinsat  arranca sin satélite

   El reporte de verificación del núcleo de datos vive en verify.html.
   ============================================================ */
"use strict";

const easeOutCubic = x => 1 - Math.pow(1 - x, 3);

let renderer = null, scene = null, TilesFondo = null;

/* ---------- Opacidad y crecimiento (equivalentes a main.js:777-790) ---------- */
function applyOpacity(key, t) {
  Ground.setOpacidad(key, t);
  Veg.setOpacity(key, t);
}

function applyGrowth(key, t) {
  state.growth[key] = t;
  Veg.setGrowth(key, t);
}

/* ---------- Conmutación de escenario (port de main.js:795-826) ---------- */
function setScenario(next, animate = true) {
  if (next === state.scenario) return;
  const prev = state.scenario;
  state.scenario = next;
  actualizarEtiqueta();

  if (state.anim) cancelAnimationFrame(state.anim);
  if (!animate) {
    applyOpacity(prev, 0); applyGrowth(prev, 0);
    applyOpacity(next, 1); applyGrowth(next, 1);
    return;
  }

  const FADE_MS = 700, GROW_MS = 1800;
  const t0 = performance.now();
  const frame = now => {
    // El timestamp del primer rAF puede ser anterior a t0 (quirk de Chrome,
    // §11.4): sin este clamp salen opacidades negativas. Bug real del
    // proyecto original, ronda del 2026-07-16.
    const dt = Math.max(0, now - t0);
    const fade = Math.min(dt / FADE_MS, 1);
    const grow = easeOutCubic(Math.min(dt / GROW_MS, 1));
    applyOpacity(prev, 1 - fade);
    applyOpacity(next, fade);
    applyGrowth(prev, 1 - grow);
    applyGrowth(next, grow);
    if (dt < GROW_MS) state.anim = requestAnimationFrame(frame);
    else state.anim = null;
  };
  state.anim = requestAnimationFrame(frame);
}

/* ---------- UI mínima (en VR casi no hay DOM; esto es para escritorio) ---------- */
function actualizarEtiqueta() {
  const el = document.getElementById("escenario");
  if (!el) return;
  const nat = NATURE_CLASSES.reduce((s, c) => s + (state.stats[state.scenario][c] || 0), 0);
  el.innerHTML = `<b>${state.campo.nombre}</b> · ` +
    (state.scenario === "inicial" ? "Paisaje Actual" : "Paisaje Multifuncional") +
    ` · naturaleza ${nat.toLocaleString("es-AR", { maximumFractionDigits: 1 })} ha`;
}

function carga(txt, pct) {
  const el = document.getElementById("carga");
  if (!el) return;
  if (txt === null) { el.style.display = "none"; return; }
  el.style.display = "flex";
  el.querySelector(".txt").textContent = txt;
  el.querySelector(".barra i").style.width = (pct == null ? 0 : pct * 100) + "%";
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  Rig.camera.aspect = w / h;
  Rig.camera.updateProjectionMatrix();
}

/* ---------- Arranque ---------- */
(async function main() {
  try {
    const canvas = document.getElementById("vista");
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: true,
      preserveDrawingBuffer: true   // permite capturar el canvas a PNG (§11.1)
    });
    // OJO: NO tocar outputEncoding ni toneMapping. En r149 el default es
    // LinearEncoding y el original no lo cambia; cambiarlo acá rompería la
    // paridad de color con la app publicada (§5.2).
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight, false);

    scene = new THREE.Scene();
    Rig.init(scene, innerWidth / innerHeight);
    Sky.init(scene);
    Veg.addLuces(scene);
    addEventListener("resize", onResize);

    carga("Cargando el campo…", 0.05);
    await loadCampos();
    document.title = `AgroDesign · Navegador 3D VR · ${state.campo.nombre}`;
    // El tier se aplica ANTES de loadData(): pisa los topes de generación de
    // matas, porque cada instancia cuesta memoria y tiempo de construcción
    // aunque el culling por radio después no la dibuje (§9.5).
    Perf.aplicarTier();
    if (Perf.dial.pixelRatio) renderer.setPixelRatio(Perf.dial.pixelRatio);
    await loadData();
    const extent = sceneExtent();

    if (!params.has("sinsat")) {
      carga("Bajando imagen satelital…", 0.1);
      // el zoom del atlas lo limitan dos cosas: hasta dónde tiene imagen Esri
      // en ese campo, y el dial del tier (§9.1 y §9.5)
      const z = params.has("z") ? +params.get("z")
        : Math.min(state.campo.maxzoom || 17, Perf.dial.zoomAtlas);
      const info = await Tiles.load(state.bbox, z, {
        onProgress: (n, tot) => carga(`Bajando imagen satelital… ${n}/${tot}`, 0.1 + 0.6 * n / tot)
      });
      console.log("tiles:", info);
      Ground.buildSatelite(scene, Tiles.atlases);

      // Fondo de bajo zoom: extiende el suelo ~30 km alrededor, para que el
      // borde de la cobertura de detalle nunca entre en cuadro (§9.6). Son
      // pocas decenas de tiles y un solo draw call.
      carga("Bajando el fondo lejano…", 0.72);
      TilesFondo = Object.create(Tiles);
      const infoF = await TilesFondo.load(state.bbox, 13, { margenM: 12000 });
      console.log("tiles fondo:", infoF);
      Ground.buildSatelite(scene, TilesFondo.atlases, { fondo: true });
    }

    carga("Armando el paisaje…", 0.75);
    await new Promise(r => setTimeout(r, 0));   // deja pintar el overlay
    for (const key of ["inicial", "multi"]) {
      Ground.buildEscenario(scene, key);
      Veg.build(scene, key);
    }

    // Estado inicial: paisaje actual visible y crecido, multifuncional en 0
    state.scenario = "inicial";
    applyOpacity("inicial", 1); applyGrowth("inicial", 1);
    applyOpacity("multi", 0); applyGrowth("multi", 0);

    Rig.alturaDron = (state.campo.vr && state.campo.vr.alturaDron) || 18;
    Rig.home(extent, params.has("alt") ? { altura: +params.get("alt") } : {});
    actualizarEtiqueta();
    Perf.init(document.getElementById("hud"), DEBUG);

    DisplayFlat.init(renderer, scene, Rig, {
      // `msFrame` es el tiempo REAL del frame: el driver manda por separado
      // el que usa la locomoción (topeado) y el que se mide (crudo)
      onUpdate: (msFrame, now) => {
        Veg.tick(now / 1000);          // reloj del viento
        Sky.update(Rig);
        Chunks.update(Rig.rig.position, now);
        Perf.frame(renderer, msFrame);
      },
      onAction: acc => {
        if (acc === "toggleScenario") setScenario(state.scenario === "inicial" ? "multi" : "inicial");
        else if (acc === "home") { Rig.home(extent); Chunks.invalidar(); }
        else if (acc === "modo") { Rig.alternarModo(); Chunks.invalidar(); }
      }
    });
    DisplayFlat.start();
    carga(null);

    if (DEBUG) {
      window.__vr = {
        state, renderer, scene, Rig, Sky, Tiles, TilesFondo, Ground, Veg, Perf, Chunks, DisplayFlat,
        setScenario, applyOpacity, applyGrowth, extent,
        lonLatToScene, sceneToLonLat, projInfo,
        info: () => ({
          campo: state.campo.id, escenario: state.scenario,
          tiles: Tiles.info, suelo: Ground.info(), veg: Veg.info(),
          chunks: Chunks.info(), perf: Perf.snapshot(renderer),
          camara: {
            x: +Rig.rig.position.x.toFixed(1), z: +Rig.rig.position.z.toFixed(1),
            altura: +Rig.alturaOjo().toFixed(1), rumbo: +Rig.rumbo().toFixed(1)
          }
        })
      };
      console.log("window.__vr expuesto. Probá __vr.info()");
    }
  } catch (err) {
    console.error(err);
    carga(null);
    const el = document.getElementById("error");
    if (el) { el.style.display = "block"; el.textContent = (err && err.stack) || String(err); }
  }
})();
