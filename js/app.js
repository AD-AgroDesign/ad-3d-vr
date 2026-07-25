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
     ?modo=flat|cardboard                  ?tier=phone|quest|desktop
     ?pose=aerea|dron|corredor             ?escenario=inicial|multi
     ?pr=<n>       pixelRatio (nitidez)    ?cabeza=predictiva|cruda|absoluta

   El reporte de verificación del núcleo de datos vive en verify.html, y el
   diagnóstico del dispositivo en diag.html.
   ============================================================ */
"use strict";

const easeOutCubic = x => 1 - Math.pow(1 - x, 3);

let renderer = null, scene = null, TilesFondo = null;
let driver = null;

/* Modo de display por query string (§5.3). El default es `flat` también en
   teléfono, a propósito: entrar en estéreo exige un GESTO del usuario para
   la pantalla completa, el bloqueo de orientación y el wake lock (§9.9), así
   que el camino normal es el botón "Entrar en VR". `?modo=cardboard` arranca
   directo en estéreo para el guion de prueba física de §11.3. */
const MODO = params.get("modo") || "flat";

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

function aviso(html) {
  const el = document.getElementById("aviso");
  if (!el) return;
  if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = html;
}

/* ---------- Poses iniciales ----------

   `aerea` es la vista del proyecto original (sobrevuelo del campo entero) y
   sigue siendo el default en escritorio. En teléfono NO sirve: con el
   radioMax de 400 m del tier `phone` la vista aérea se ve sin vegetación
   (medido en el Android del dueño: 32 k triángulos, una escena casi vacía).
   Por eso en `phone` y en cardboard el default es la pose de dron dentro del
   corredor más largo, que además es la pose de VR y la única forma de medir
   el presupuesto real sin input (que recién llega en P5). */
function aplicarPose(nombre, extent) {
  const fc = state.data[state.scenario] || state.data.multi;
  if (nombre === "corredor") {
    const r = Rig.poseCorredor(fc);
    if (r) return r;
    console.warn("pose=corredor: no hay corredor con eje > 300 m; se usa la pose de dron");
    nombre = "dron";
  }
  if (nombre === "dron") return Rig.poseDron(extent);
  Rig.home(extent, params.has("alt") ? { altura: +params.get("alt") } : {});
  return { pose: "aerea", altura: Rig.alturaOjo() };
}

/* ---------- Drivers de display ----------
   Los dos drivers comparten el MISMO rig y las mismas callbacks: cambiar de
   modo es parar uno y arrancar el otro (§5.3b). */
function usarDriver(nuevo) {
  if (driver === nuevo) return;
  if (driver) driver.stop();
  driver = nuevo;
  document.body.classList.toggle("estereo", nuevo.label === "cardboard");
  Perf.espejo(nuevo.label === "cardboard");
  Perf.linea = "";
  driver.start();
  actualizarBotones();
}

/* Tiene que llamarse DESDE el gesto del usuario: la pantalla completa, el
   bloqueo de orientación y el wake lock lo exigen (§9.9). */
async function entrarVR() {
  // Desde una vista aérea, entrar en estéreo deja el campo 900 m abajo y
  // fuera de cuadro: se baja a altura de dron conservando la posición.
  if (Rig.alturaOjo() > 60) { Rig.setAlturaOjo(Rig.alturaDron); Chunks.invalidar(); }
  usarDriver(DisplayCardboard);
  await Inmersion.entrar();
  actualizarBotones();
}

async function salirVR() {
  usarDriver(DisplayFlat);
  aviso(null);
  await Inmersion.salir();
  actualizarBotones();
}

function actualizarBotones() {
  const enVR = driver === DisplayCardboard;
  const btnVR = document.getElementById("btn-vr");
  const btnRec = document.getElementById("btn-recentrar");
  const btnSalir = document.getElementById("btn-salir");
  if (!btnVR) return;
  // en cardboard el botón principal pasa a ser el de pantalla completa, y
  // desaparece cuando ya se está en pantalla completa
  btnVR.textContent = enVR ? "Pantalla completa" : "Entrar en VR";
  btnVR.hidden = enVR && Inmersion.enFullscreen();
  btnRec.hidden = !enVR;
  btnSalir.hidden = !enVR;
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
    // El tier `phone` fuerza pixelRatio 1,0, y en el teléfono del dueño el
    // devicePixelRatio real es 2,16: con estéreo eso deja 557×501 por ojo en
    // una pantalla de 2400 px de ancho, o sea imagen blanda. Como la medición
    // real dio 60 fps con margen, `?pr=` permite probar 1,25 / 1,5 y decidir
    // con el número en la mano en vez de suponer.
    const pr = params.has("pr") ? Math.min(+params.get("pr"), devicePixelRatio)
      : Perf.dial.pixelRatio;
    if (pr) renderer.setPixelRatio(pr);
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

    // Estado inicial: un escenario visible y crecido, el otro en 0.
    // ?escenario=multi arranca en el Paisaje Multifuncional: es lo que hace
    // falta para medir el peor caso en el teléfono sin depender del input.
    state.scenario = params.get("escenario") === "multi" ? "multi" : "inicial";
    const otro = state.scenario === "multi" ? "inicial" : "multi";
    applyOpacity(state.scenario, 1); applyGrowth(state.scenario, 1);
    applyOpacity(otro, 0); applyGrowth(otro, 0);

    Rig.alturaDron = (state.campo.vr && state.campo.vr.alturaDron) || 18;
    const enMovil = Perf.tier === "phone" || MODO === "cardboard";
    const poseInfo = aplicarPose(params.get("pose") || (enMovil ? "corredor" : "aerea"), extent);
    console.log("pose inicial:", poseInfo);
    actualizarEtiqueta();
    Perf.init(document.getElementById("hud"), DEBUG, document.getElementById("hud2"));

    /* Las dos callbacks son las mismas para los dos drivers: el que cambia
       es cómo se presenta el frame, no lo que pasa en la escena. */
    const cbs = {
      // `msFrame` es el tiempo REAL del frame: el driver manda por separado
      // el que usa la locomoción (topeado) y el que se mide (crudo)
      onUpdate: (msFrame, now) => {
        Veg.tick(now / 1000);          // reloj del viento
        Sky.update(Rig);
        Chunks.update(Rig.rig.position, now);
        if (Perf.activo && driver === DisplayCardboard) {
          const c = Cabeza.fuente === "sensores"
            ? `cabeza ${Cabeza.hz.toFixed(0)} Hz · ${Cabeza.modo}` +
              (Cabeza.absoluto === false ? " · deriva" : "")
            : `<span class="warn">cabeza ${Cabeza.fuente}</span>`;
          Perf.linea = `estéreo · ${c}`;
        }
        Perf.frame(renderer, msFrame);
      },
      onAction: acc => {
        if (acc === "toggleScenario") setScenario(state.scenario === "inicial" ? "multi" : "inicial");
        else if (acc === "home") { aplicarPose("aerea", extent); Chunks.invalidar(); }
        else if (acc === "modo") { Rig.alternarModo(); Chunks.invalidar(); }
        else if (acc === "recenter" && driver === DisplayCardboard) DisplayCardboard.recentrar();
      }
    };

    DisplayFlat.init(renderer, scene, Rig, cbs);
    DisplayCardboard.init(renderer, scene, Rig, Object.assign({ onAviso: aviso }, cbs));

    /* Botones. Con el visor puesto no se puede tocar la pantalla, así que
       estos son para ANTES de meter el teléfono; el mando llega en P5. */
    document.getElementById("btn-vr").addEventListener("click", () => {
      if (driver === DisplayCardboard) Inmersion.entrar().then(actualizarBotones);
      else entrarVR();
    });
    document.getElementById("btn-recentrar").addEventListener("click", () => DisplayCardboard.recentrar());
    document.getElementById("btn-salir").addEventListener("click", salirVR);
    // Si el usuario sale de pantalla completa con el gesto del sistema, salir
    // del estéreo en vez de quedar con la imagen doble cortada por las barras
    // del navegador (§9.9).
    for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
      document.addEventListener(ev, () => {
        if (driver === DisplayCardboard && Inmersion.activa && !Inmersion.enFullscreen()) salirVR();
        else actualizarBotones();
      });
    }

    if (MODO === "cardboard") usarDriver(DisplayCardboard);
    else usarDriver(DisplayFlat);
    carga(null);

    if (DEBUG) {
      window.__vr = {
        state, renderer, scene, Rig, Sky, Tiles, TilesFondo, Ground, Veg, Perf, Chunks,
        DisplayFlat, DisplayCardboard, Cabeza, Inmersion,
        setScenario, applyOpacity, applyGrowth, extent,
        aplicarPose: n => aplicarPose(n, extent), entrarVR, salirVR, usarDriver,
        lonLatToScene, sceneToLonLat, projInfo,
        info: () => ({
          campo: state.campo.id, escenario: state.scenario,
          modo: driver ? driver.label : null,
          tiles: Tiles.info, suelo: Ground.info(), veg: Veg.info(),
          chunks: Chunks.info(), perf: Perf.snapshot(renderer),
          estereo: DisplayCardboard.info(),
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
