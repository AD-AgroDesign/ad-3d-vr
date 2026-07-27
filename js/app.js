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
     ?modo=flat|cardboard|xr               ?tier=phone|quest|desktop
     ?pose=aerea|dron|corredor             ?escenario=inicial|multi
     ?pr=<n>       pixelRatio (nitidez)    ?cabeza=predictiva|cruda|absoluta
     ?sep=<px>|auto  separación de los centros de imagen (fusión en el visor)
     ?calib        el stick ajusta la separación en vez de girar
     ?giro=snap    vuelve al giro de ±30° (el default es continuo)
     ?fbs=<n>      escala del framebuffer en WebXR (nitidez contra fps)

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

/* ---------- Conmutación de escenario (port de main.js:795-826) ----------

   La animación NO tiene loop propio: la avanza el driver de turno desde su
   callback de update. Tenía un `requestAnimationFrame` de la ventana, y eso
   se rompe en WebXR — dentro de una sesión inmersiva el rAF del documento se
   frena (el que corre es el de la sesión), así que el cross-fade quedaba
   congelado y el paisaje nuevo no terminaba de crecer hasta salir.
   Ticked desde el driver funciona igual en flat, cardboard y XR, que es
   justamente la razón de ser de la arquitectura de §5.3. */
const FADE_MS = 700, GROW_MS = 1800;
let animEscenario = null;         // { prev, next, t0 }

function setScenario(next, animate = true) {
  if (next === state.scenario) return;
  const prev = state.scenario;
  state.scenario = next;
  actualizarEtiqueta();

  animEscenario = null;
  if (!animate) {
    applyOpacity(prev, 0); applyGrowth(prev, 0);
    applyOpacity(next, 1); applyGrowth(next, 1);
    return;
  }
  animEscenario = { prev, next, t0: performance.now() };
}

/* Un paso de la animación. `now` lo trae el driver; el Math.max(0, ...) es por
   el quirk de rAF de §11.4, donde el primer timestamp puede ser anterior a t0
   (bug real del proyecto original, ronda del 2026-07-16). */
function tickEscenario(now) {
  const a = animEscenario;
  if (!a) return;
  const dt = Math.max(0, now - a.t0);
  const fade = Math.min(dt / FADE_MS, 1);
  const grow = easeOutCubic(Math.min(dt / GROW_MS, 1));
  applyOpacity(a.prev, 1 - fade);
  applyOpacity(a.next, fade);
  applyGrowth(a.prev, 1 - grow);
  applyGrowth(a.next, grow);
  if (dt >= GROW_MS) animEscenario = null;
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
  // Guarda contra 0×0: pasa con la pestaña oculta o durante una rotación de
  // pantalla, y `aspect = 0/0` deja la matriz de proyección en NaN — o sea
  // pantalla negra hasta el próximo resize. Visto en el panel embebido.
  if (w < 1 || h < 1) return;
  // En WebXR el tamaño del cuadro, la proyección y el fov los pone el runtime:
  // setSize no tiene efecto mientras presenta y reajustar la viñeta acá le
  // pisaría la escala calculada con el fov real del visor.
  if (driver === DisplayWebXR && DisplayWebXR.corriendo) return;
  renderer.setSize(w, h, false);
  Rig.camera.aspect = w / h;
  Rig.camera.updateProjectionMatrix();
  // la viñeta se escala al cuadro; en estéreo el aspect es el de un ojo
  const estereo = driver === DisplayCardboard;
  Vigneta.ajustar(Rig.camera, Rig.camera.aspect * (estereo ? 0.5 : 1));
  if (estereo) DisplayCardboard.aplicarSepCss();
}

/* Banner del tour (§9.13, punto 1). Se pinta en los dos paneles: en cardboard
   el de una esquina no se lee con el visor puesto, así que va uno por ojo, en
   el centro de cada lente, con las mismas reglas del HUD. */
function bannerTour(txt) {
  for (const id of ["tour", "tour2"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = txt || "";
    // el espejo del ojo derecho sólo tiene sentido en estéreo
    const espejo = id === "tour2" && driver !== DisplayCardboard;
    el.style.display = (txt && !espejo) ? "block" : "none";
  }
}

function aviso(html) {
  const el = document.getElementById("aviso");
  if (!el) return;
  el.classList.remove("reporte");     // la pone sólo el reporte de WebXR
  if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = html;
}

/* Mensaje de la calibración de separación. Dice el valor en px y su
   equivalente aproximado en mm, con la salvedad honesta de que el navegador
   NO expone el DPI físico: la conversión asume el nominal de Android
   (1 px CSS ≈ 1/160 de pulgada) y puede errar ~15 %. Sirve para saber si se
   está cerca de una IPD humana (58–68 mm), no como medida de precisión. */
function textoSeparacion(px) {
  const mm = px * 25.4 / 160;
  return `Separación de imágenes: <b>${px} px</b> (~${mm.toFixed(0)} mm) · ` +
    `IPD humana típica 58–68 mm.<br>` +
    `Ajustá hasta que las dos vistas se fusionen en una. Queda recordada; ` +
    `también se puede fijar con <b>?sep=${px}</b>.`;
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
  Menu.poseActual = nombre;                  // el menú muestra la pose vigente
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
  Menu.espejo(nuevo.label === "cardboard");
  Perf.linea = "";
  // ventana de medición limpia: cada driver se mide a sí mismo, y el frame
  // gigante de un diálogo del navegador no puede contaminar al siguiente
  Perf.reiniciarMuestras();
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

/* ---------- WebXR (P7, driver alternativo) ----------

   Va por un botón aparte, no reemplazando "Entrar en VR": el cardboard es el
   camino aceptado por el dueño y este es el experimento. La sesión exige un
   GESTO del usuario, así que ?modo=xr no puede entrar solo — lo que hace es
   que el botón principal pida XR en lugar de cardboard. */
/* El mando tiene que estar DESPIERTO antes de entrar: Chrome no entrega datos
   de un gamepad que todavía no interactuó con la página, y dentro de la sesión
   la pulsación ya no lo despierta (la prueba real del 2026-07-26 se comió una
   sesión entera así). El primer intento avisa; el segundo entra igual, porque
   puede no haber mando y no hay que bloquear el camino. */
let _insistirXR = false;
let _vigilaMando = 0;

/* El aviso tiene que CONTESTAR cuando el mando despierta. La primera versión
   era un cartel fijo: el dueño apretaba el botón, la escena respondía y el
   texto seguía diciendo lo mismo, así que no había forma de saber si había
   servido. Se vigila la bandera (la escribe Input.leer() en cada frame) y el
   cartel cambia solo. */
function vigilarMando() {
  clearInterval(_vigilaMando);
  _vigilaMando = setInterval(() => {
    if (!Input.activado) return;
    clearInterval(_vigilaMando); _vigilaMando = 0;
    aviso(`<b>✓ Mando detectado.</b> Ya va a responder adentro de la sesión.<br>` +
      `Tocá <b>Probar WebXR</b> para entrar.`);
  }, 150);
}

async function entrarXR() {
  if (!Input.activado && !_insistirXR) {
    _insistirXR = true;
    aviso(`<b>Apretá un botón del mando antes de entrar.</b><br>` +
      `Todavía no mandó nada a la página, y adentro de la sesión ya no se puede ` +
      `despertar: el mando aparecería pero no respondería.<br>` +
      `Este cartel avisa solo cuando lo detecte. ` +
      `Si no tenés mando a mano, tocá <b>Probar WebXR</b> de nuevo para entrar igual.`);
    vigilarMando();
    return;
  }
  clearInterval(_vigilaMando); _vigilaMando = 0;
  _insistirXR = false;
  if (Rig.alturaOjo() > 60) { Rig.setAlturaOjo(Rig.alturaDron); Chunks.invalidar(); }
  aviso("Abriendo la sesión WebXR…");
  const r = await DisplayWebXR.entrar();
  if (!r.ok) {
    aviso(`<b>No se pudo abrir WebXR:</b> ${r.motivo}<br>` +
      `El modo cardboard sigue disponible en "Entrar en VR".`);
    actualizarBotones();
    return;
  }
  aviso(null);
  usarDriver(DisplayWebXR);
  actualizarBotones();
}

/* Al terminar la sesión (la corte el usuario, el botón o el visor) se vuelve
   al modo plano y se muestra el reporte de lo medido: dentro de la sesión el
   DOM no se ve, así que ésta es la única forma de que el dueño lea los fps, el
   framebuffer y si el mando llegó a la sesión. */
function finXR(reporte) {
  usarDriver(DisplayFlat);
  aviso(`<b>Reporte de la sesión WebXR</b><pre>${(reporte || "").replace(/</g, "&lt;")}</pre>` +
    `<small>También está en la consola y en <b>__vr.info().webxr</b>.</small>`);
  const el = document.getElementById("aviso");
  if (el) el.classList.add("reporte");
  actualizarBotones();
}

/* ---------- Tour (P6) ----------
   El tour recorre el paisaje MULTIFUNCIONAL: los corredores y los parches de
   naturaleza sólo existen ahí, y los textos del guión hablan de eso ("el
   paisaje rediseñado"). Si está puesto el Paisaje Actual, conmuta al arrancar
   —con su cross-fade— en vez de volar sobre corredores invisibles. */
function alternarTour(extent) {
  if (Tour.activo) { Tour.detener("el usuario"); return; }
  if (state.scenario !== "multi") setScenario("multi");
  if (!Tour.arrancar(state.data.multi, extent, performance.now()))
    aviso("En este campo no hay corredores ni parches para armar el tour.");
}

/* ---------- Menú (P6) ----------
   Las opciones que ya tienen botón en el mando (conmutar paisaje, tour,
   recentrar) están igual en el menú: con el visor puesto no hay forma de
   recordar un mapeo de cuatro botones, y el menú es el que lo hace explícito.
   Las dos que NO se podían hacer sin sacarse el visor son la pose y el campo. */
const POSES = ["aerea", "dron", "corredor"];

function accionDeMenu(id, dato, extent) {
  if (id === "paisaje") setScenario(state.scenario === "inicial" ? "multi" : "inicial");
  else if (id === "vista") {
    const i = POSES.indexOf(Menu.poseActual);
    const pose = POSES[(i + 1) % POSES.length];
    console.log("pose:", aplicarPose(pose, extent));
    Chunks.invalidar();
  } else if (id === "tour") alternarTour(extent);
  else if (id === "recentrar") { if (driver === DisplayCardboard) DisplayCardboard.recentrar(); }
  else if (id === "salir") { Menu.cerrar(); if (driver === DisplayWebXR) DisplayWebXR.salir(); else salirVR(); }
  else if (id === "campo") cambiarCampo(dato);
}

/* Cambiar de campo recarga la página: el campo define la proyección, el
   satélite, el suelo y toda la vegetación, o sea prácticamente la escena
   entera. Reconstruirla en caliente es una fase en sí misma y no vale la pena
   antes de saber si el menú queda así (§9.13 quedó pendiente de revisión).
   Se conservan los parámetros de la URL para no perder el modo ni los diales,
   y se avisa lo que cuesta: hay que volver a entrar en VR. */
function cambiarCampo(id) {
  if (!id || (state.campo && state.campo.id === id)) { Menu.cerrar(); return; }
  const p = new URLSearchParams(location.search);
  p.set("campo", id);
  Menu.cerrar();
  aviso("Cambiando de campo… hay que volver a entrar en VR.");
  location.search = p.toString();
}

function actualizarBotones() {
  const enVR = driver === DisplayCardboard;
  const enXR = driver === DisplayWebXR;
  const btnVR = document.getElementById("btn-vr");
  const btnRec = document.getElementById("btn-recentrar");
  const btnSalir = document.getElementById("btn-salir");
  const btnXR = document.getElementById("btn-xr");
  for (const id of ["btn-sep-menos", "btn-sep-mas"]) {
    const b = document.getElementById(id);
    if (b) b.hidden = !enVR;
  }
  // el botón de XR sólo aparece si el dispositivo dice que puede: en un
  // escritorio sin visor no tiene sentido ofrecerlo
  if (btnXR) btnXR.hidden = !DisplayWebXR.soporte || enVR || enXR;
  if (!btnVR) return;
  // en cardboard el botón principal pasa a ser el de pantalla completa, y
  // desaparece cuando ya se está en pantalla completa
  btnVR.textContent = MODO === "xr" ? "Entrar en VR (WebXR)"
    : (enVR ? "Pantalla completa" : "Entrar en VR");
  btnVR.hidden = enXR || (enVR && Inmersion.enFullscreen());
  btnRec.hidden = !enVR;
  btnSalir.hidden = !enVR && !enXR;
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
      onUpdate: (msFrame, now, dtMs) => {
        tickEscenario(now);            // el cross-fade lo avanza el driver, no el rAF del DOM
        // el tour se cancela solo si el usuario toma el control (ver Tour.update)
        if (Tour.activo) Tour.update(dtMs || 16, now);
        if (Menu.abierto) Menu.update(dtMs || 16, now);
        Veg.tick(now / 1000);          // reloj del viento
        Sky.update(Rig);
        Chunks.update(Rig.rig.position, now);
        if (Perf.activo && driver === DisplayCardboard) {
          const c = Cabeza.fuente === "sensores"
            ? `cabeza ${Cabeza.hz.toFixed(0)} Hz · ${Cabeza.modo}` +
              (Cabeza.absoluto === false ? " · deriva" : "")
            : `<span class="warn">cabeza ${Cabeza.fuente}</span>`;
          Perf.linea = `estéreo sep ${Math.round(DisplayCardboard.separacion())} px · ${c}`;
        }
        Perf.frame(renderer, msFrame);
      },
      onAction: acc => {
        /* Con el menú abierto, el mando es del menú: las acciones se desvían
           en vez de ejecutarse. Es lo que permite que el mismo botón que
           conmuta el paisaje sirva de "aceptar" adentro del menú. */
        if (acc === "menu" || Menu.abierto) { Menu.accionDeMando(acc); return; }
        /* Cualquier acción que no sea el propio tour lo corta: si no, el
           usuario y el tour se pelearían por el rig. Es lo que hace el
           original con los eventos del canvas (main.js:1163).

           **Con una excepción, pedida por el dueño tras probar el tour en el
           visor (2026-07-26): conmutar el paisaje NO lo corta.** Y tiene toda
           la lógica: es la acción estrella del proyecto (§9.13, punto 3) y es
           la única que no pelea por el rig — no mueve nada, cambia lo que se
           ve. Poder alternar Actual / Multifuncional desde el mismo punto de
           vista, mientras el tour sigue volando, es la mejor demostración que
           tiene la app. */
        if (acc !== "tour" && acc !== "toggleScenario" && Tour.activo)
          Tour.detener("acción del usuario");
        if (acc === "toggleScenario") setScenario(state.scenario === "inicial" ? "multi" : "inicial");
        else if (acc === "home") { aplicarPose("aerea", extent); Chunks.invalidar(); }
        else if (acc === "modo") { Rig.alternarModo(); Chunks.invalidar(); }
        else if (acc === "recenter" && driver === DisplayCardboard) DisplayCardboard.recentrar();
        // el snap lo ejecuta el rig (transición de 80 ms, §9.11.3)
        else if (acc === "snapIzq") Rig.snap(-1);
        else if (acc === "snapDer") Rig.snap(+1);
        // ?calib: ajustar la separación con el mando, con el visor puesto
        else if (acc === "sepMenos") aviso(textoSeparacion(DisplayCardboard.ajustarSeparacion(-4)));
        else if (acc === "sepMas") aviso(textoSeparacion(DisplayCardboard.ajustarSeparacion(+4)));
        else if (acc === "tour") alternarTour(extent);
      }
    };

    // Una sola fuente de entrada para los dos drivers (§5.3c)
    Input.init({ onAction: cbs.onAction });
    Vigneta.init(Rig);
    Tour.init({
      onMensaje: bannerTour,
      onFin: motivo => console.log("tour: fin (" + motivo + ")")
    });
    Menu.init({ onAccion: (id, dato) => accionDeMenu(id, dato, extent) });

    DisplayFlat.init(renderer, scene, Rig, cbs);
    DisplayCardboard.init(renderer, scene, Rig, Object.assign({ onAviso: aviso }, cbs));
    DisplayWebXR.init(renderer, scene, Rig, Object.assign({ onAviso: aviso, onSalir: finXR }, cbs));
    // La consulta es asíncrona y no bloquea el arranque: cuando contesta,
    // aparece (o no) el botón de "Probar WebXR".
    DisplayWebXR.disponible().then(ok => {
      console.log("webxr immersive-vr soportado:", ok);
      actualizarBotones();
    });

    /* Botones. Con el visor puesto no se puede tocar la pantalla, así que
       estos son para ANTES de meter el teléfono; el mando llega en P5. */
    document.getElementById("btn-vr").addEventListener("click", () => {
      if (MODO === "xr") entrarXR();
      else if (driver === DisplayCardboard) Inmersion.entrar().then(actualizarBotones);
      else entrarVR();
    });
    document.getElementById("btn-xr").addEventListener("click", entrarXR);
    document.getElementById("btn-recentrar").addEventListener("click", () => DisplayCardboard.recentrar());
    document.getElementById("btn-salir").addEventListener("click", () => {
      if (driver === DisplayWebXR) DisplayWebXR.salir();
      else salirVR();
    });
    // Calibración de la separación de imágenes. Se ajusta mirando la pantalla
    // a la distancia de las lentes, ANTES de meter el teléfono en el visor:
    // el valor correcto es el que hace que las dos vistas se fusionen en una.
    document.getElementById("btn-sep-menos").addEventListener("click",
      () => aviso(textoSeparacion(DisplayCardboard.ajustarSeparacion(-8))));
    document.getElementById("btn-sep-mas").addEventListener("click",
      () => aviso(textoSeparacion(DisplayCardboard.ajustarSeparacion(+8))));
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
        DisplayFlat, DisplayCardboard, DisplayWebXR, Cabeza, Inmersion, Input, Vigneta, Tour, Menu,
        alternarTour: () => alternarTour(extent),
        accionDeMenu: (id, dato) => accionDeMenu(id, dato, extent),
        setScenario, tickEscenario, applyOpacity, applyGrowth, extent,
        animEscenario: () => animEscenario,
        aplicarPose: n => aplicarPose(n, extent), entrarVR, salirVR, entrarXR, usarDriver,
        lonLatToScene, sceneToLonLat, projInfo,
        info: () => ({
          campo: state.campo.id, escenario: state.scenario,
          modo: driver ? driver.label : null,
          tiles: Tiles.info, suelo: Ground.info(), veg: Veg.info(),
          chunks: Chunks.info(), perf: Perf.snapshot(renderer),
          estereo: DisplayCardboard.info(), webxr: DisplayWebXR.info(), input: Input.info(),
          tour: Tour.info(), menu: Menu.info(),
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
