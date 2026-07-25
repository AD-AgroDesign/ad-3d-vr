/* ============================================================
   display-cardboard.js — Driver de display ESTÉREO para teléfono en visor
   tipo cardboard (§5.3b, §9.7, §9.8, §9.9).

   Esto NO es WebXR. En un teléfono común no existe `immersive-vr`: Chrome
   retiró el soporte Cardboard/WebVR (§5.1). Acá el estéreo se hace a mano
   con THREE.StereoCamera + dos viewports sobre el mismo canvas, y la cabeza
   se lee de `deviceorientation`.

   Tres piezas en este archivo:
   1. `Cabeza`   — deviceorientation → quaternion de la CÁMARA, con
                   recentrado de yaw (la brújula deriva: no es opcional).
   2. `Inmersion`— pantalla completa + bloqueo de orientación + wake lock.
   3. `DisplayCardboard` — la misma interfaz mínima que DisplayFlat
                   (init/start/stop/render/label) sobre el MISMO rig, así
                   que la locomoción no se reescribe.

   Reparto de rotaciones (regla de confort §9.11.2): el rig sólo rota en
   YAW y lo escribe la locomoción; el pitch y el roll vienen sólo de la
   cabeza real. El horizonte nunca se inclina por software.
   ============================================================ */
"use strict";

/* FOV vertical del modo cardboard (§9.7): con 60 se siente como mirar por
   un tubo; con más de 100 la distorsión sin corregir se vuelve intolerable. */
const FOV_CARDBOARD = 90;

/* Separación interocular en metros. La escena está en metros, así que este
   valor es literal. Dial razonable: 0,058–0,068. */
const IPD = 0.064;

/* Predicción de la pose de la cabeza.

   Medido en el Android del dueño (2026-07-25): `deviceorientation` llega a
   **19 Hz**, no a los ~60 Hz que asumía §9.8. A 60 fps eso significa que la
   misma muestra se sostiene tres frames y después salta: se ve como
   escalones al girar la cabeza y es justo el tipo de cosa que marea.

   La corrección es la de cualquier runtime de VR: estimar la velocidad
   angular con las dos últimas muestras y extrapolar hasta el instante del
   frame (`slerp` con t > 1 extrapola bien mientras el ángulo sea chico).
   NO es un filtro de suavizado: un lerp hacia la muestra vieja agregaría
   latencia, que es lo que §9.8 prohíbe con razón. Esto RESTA latencia.

   `PRED_TOPE_MS` acota el sobrepaso cuando el giro cambia de sentido, y
   `TAU_MS` sólo lima la discontinuidad de cuando entra una muestra nueva
   (amortiguado POR TIEMPO, §12.2). */
const PRED_TOPE_MS = 40;
const TAU_MS = 18;

/* ============================================================
   Cabeza — head tracking por deviceorientation (§9.8)

   `DeviceOrientationControls` fue removido de Three y NO está en el bundle
   vendorizado, así que se reimplementa el algoritmo canónico. El orden de
   Euler es YXZ y el gamma va NEGADO: no es un detalle estético, con
   cualquier otro orden la cabeza se mueve en ejes cruzados.
   ============================================================ */
const Cabeza = {
  fuente: "ninguna",        // "sensores" | "mouse" | "ninguna"
  modo: "predictiva",       // "predictiva" | "cruda"  (?cabeza=)
  evento: "deviceorientation",   // o "deviceorientationabsolute" (?cabeza=absoluta)
  eventos: 0,
  hz: 0,
  absoluto: null,           // event.absolute: si es false, el yaw DERIVA
  alpha: 0, beta: 0, gamma: 0,
  orient: 0,                // ángulo de la pantalla, en radianes
  activa: false,
  onSinSensores: null,      // se llama si no llega ningún evento en 1,5 s

  _q: new THREE.Quaternion(),
  _qAct: new THREE.Quaternion(),    // última muestra
  _qAnt: new THREE.Quaternion(),    // la anterior (para la velocidad angular)
  _qSal: new THREE.Quaternion(),    // pose extrapolada
  _qAplic: new THREE.Quaternion(),  // pose realmente aplicada (suavizada)
  _tAct: 0, _tAnt: 0, _tAplic: 0,
  _qYawFix: new THREE.Quaternion(),
  _euler: new THREE.Euler(),
  _q0: new THREE.Quaternion(),
  // -90° en X: pasa del marco del dispositivo (pantalla mirando al cielo)
  // al de la escena (pantalla mirando al frente)
  _q1: new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2),
  _zee: new THREE.Vector3(0, 0, 1),
  _ejeY: new THREE.Vector3(0, 1, 0),
  _t0: 0, _timeout: 0,
  _onEvento: null,

  activar() {
    if (this.activa) return this;
    this.activa = true;
    this.eventos = 0;
    this._t0 = performance.now();
    // ?cabeza=cruda desactiva la predicción (para comparar a ojo en el visor);
    // ?cabeza=absoluta usa el evento con magnetómetro, que no deriva pero
    // puede empeorar cerca de los imanes del visor (§9.8).
    const pedido = params.get("cabeza");
    if (pedido === "cruda") this.modo = "cruda";
    if (pedido === "absoluta") this.evento = "deviceorientationabsolute";

    this._onEvento = e => {
      // Con el sensor ausente Chrome puede entregar el evento con los tres
      // ángulos en null: eso NO cuenta como sensor presente.
      if (e.alpha === null && e.beta === null && e.gamma === null) return;
      this.eventos++;
      this.absoluto = e.absolute === undefined ? null : e.absolute;
      const D = Math.PI / 180;
      this.alpha = (e.alpha || 0) * D;
      this.beta = (e.beta || 0) * D;
      this.gamma = (e.gamma || 0) * D;
      const ahora = performance.now();
      const ms = ahora - this._t0;
      if (ms > 0) this.hz = this.eventos * 1000 / ms;
      // se guardan las dos últimas muestras con su tiempo: de ahí sale la
      // velocidad angular con la que se extrapola entre muestras
      this._qAnt.copy(this._qAct); this._tAnt = this._tAct;
      this._crudo(this._qAct); this._tAct = ahora;
      if (this.fuente !== "sensores") {
        this.fuente = "sensores";
        this._qAnt.copy(this._qAct); this._tAnt = 0;
        this._qAplic.copy(this._qAct);
        // primer evento: el yaw de arranque puede apuntar a cualquier lado
        this.recentrar();
      }
    };

    // iOS 13+ exige pedir permiso desde un gesto. En Android NO hay diálogo
    // y el evento empieza a llegar solo (§9.8, decisión D2: Android). Se
    // deja la forma escrita por compatibilidad futura, pero el flujo NO
    // está construido alrededor del permiso.
    const suscribir = () => addEventListener(this.evento, this._onEvento, true);
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then(res => { if (res === "granted") suscribir(); else this._sinSensores("permiso denegado"); })
        .catch(() => this._sinSensores("permiso rechazado"));
    } else if (typeof DeviceOrientationEvent !== "undefined") {
      suscribir();
    } else {
      this._sinSensores("el navegador no tiene DeviceOrientationEvent");
      return this;
    }

    // Detección de "no llegan eventos" (§8/P4.3). Es el fallo más probable
    // y el más confuso: sin este aviso la escena queda congelada y parece
    // un bug del render.
    this._timeout = setTimeout(() => {
      if (this.eventos === 0) this._sinSensores(
        isSecureContext ? "el dispositivo no reporta orientación"
                        : "la página NO está en contexto seguro (HTTPS)");
    }, 1500);
    return this;
  },

  _sinSensores(motivo) {
    if (this.fuente === "sensores") return;
    this.fuente = "mouse";
    if (this.onSinSensores) this.onSinSensores(motivo);
  },

  desactivar() {
    if (!this.activa) return;
    this.activa = false;
    clearTimeout(this._timeout);
    if (this._onEvento) removeEventListener(this.evento, this._onEvento, true);
    this.fuente = "ninguna";
    this._tAct = this._tAnt = this._tAplic = 0;
  },

  /* Ángulo de rotación de la pantalla, en radianes */
  _leerOrient() {
    const a = (screen.orientation && screen.orientation.angle != null)
      ? screen.orientation.angle : (window.orientation || 0);
    this.orient = a * Math.PI / 180;
    return this.orient;
  },

  /* Quaternion CRUDO de la cabeza, sin la corrección de recentrado */
  _crudo(q) {
    this._leerOrient();
    this._euler.set(this.beta, this.alpha, -this.gamma, "YXZ");  // ¡YXZ y gamma negado!
    q.setFromEuler(this._euler);
    q.multiply(this._q1);                                        // pantalla al frente
    q.multiply(this._q0.setFromAxisAngle(this._zee, -this.orient));
    return q;
  },

  /* Recentrado de yaw (§9.8, obligatorio). La brújula deriva y a veces
     arranca apuntando a cualquier lado; no se usa el norte real porque en
     VR no importa: lo que importa es que "adelante" sea adelante. */
  recentrar() {
    this._crudo(this._q);
    this._euler.setFromQuaternion(this._q, "YXZ");
    this._qYawFix.setFromAxisAngle(this._ejeY, -this._euler.y);
  },

  /* Escribe la orientación en la CÁMARA (hija del rig), nunca en el rig:
     el rig es de la locomoción.

     Entre muestras se extrapola (ver el comentario de PRED_TOPE_MS): el
     sensor de este teléfono va a 19 Hz y el render a 60, así que sin esto
     dos de cada tres frames muestran una pose vieja. */
  aplicar(camera) {
    const ahora = performance.now();
    const dtEvt = this._tAnt ? this._tAct - this._tAnt : 0;

    if (this.modo === "predictiva" && dtEvt > 4 && dtEvt < 200) {
      const adelanto = Math.min(ahora - this._tAct, PRED_TOPE_MS);
      // slerp con t > 1 extrapola: prolonga el giro de las dos últimas
      // muestras. El tope de t evita que un giro rápido se dispare.
      const t = Math.min(1 + adelanto / dtEvt, 2.5);
      this._qSal.copy(this._qAnt).slerp(this._qAct, t);
    } else {
      this._qSal.copy(this._qAct);
    }

    // Suavizado mínimo, sólo para que la llegada de cada muestra no sea un
    // escalón. Por TIEMPO, no por frame (§12.2): con 60 fps en cardboard y
    // 72–90 en XR el mismo código tiene que comportarse igual.
    const dtFrame = this._tAplic ? ahora - this._tAplic : TAU_MS;
    this._tAplic = ahora;
    this._qAplic.slerp(this._qSal, 1 - Math.exp(-dtFrame / TAU_MS));

    camera.quaternion.copy(this._qAplic).premultiply(this._qYawFix);
  }
};

/* ============================================================
   Inmersion — pantalla completa, orientación y wake lock (§9.9)

   Camino Android (decisión D2 cerrada). Sin el wake lock el teléfono se
   apaga a los 30 s dentro del visor y arruina la demostración.
   ============================================================ */
const Inmersion = {
  wakeLock: null,
  activa: false,
  _visListo: false,

  enFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); },

  /* Tiene que llamarse DESDE el gesto del usuario: fullscreen lo exige, y
     el lock de orientación exige estar ya en fullscreen. */
  async entrar() {
    this.activa = true;
    const el = document.documentElement;
    try {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) await req.call(el);
    } catch (e) { console.warn("fullscreen:", e && e.message); }
    try {
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape");
    } catch (e) { console.warn("orientation.lock:", e && e.message); }
    await this.pedirWakeLock();
    this._engancharVisibilidad();
    return this;
  },

  async salir() {
    this.activa = false;
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    try {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (this.enFullscreen() && ex) await ex.call(document);
    } catch (e) {}
    this.soltarWakeLock();
  },

  async pedirWakeLock() {
    if (!("wakeLock" in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
    } catch (e) { console.warn("wakeLock:", e && e.message); }
  },

  soltarWakeLock() {
    if (!this.wakeLock) return;
    const wl = this.wakeLock; this.wakeLock = null;
    try { wl.release(); } catch (e) {}
  },

  /* El wake lock se PIERDE al ir a background: hay que re-pedirlo (§9.9) */
  _engancharVisibilidad() {
    if (this._visListo) return;
    this._visListo = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.activa) this.pedirWakeLock();
    });
  }
};

/* ============================================================
   DisplayCardboard — el driver
   ============================================================ */
const DisplayCardboard = {
  label: "cardboard",
  renderer: null, scene: null, rig: null,
  onUpdate: null, onAction: null, onAviso: null,
  stereo: null,
  intent: { move: { x: 0, y: 0 }, turn: 0, rise: 0, turbo: false },
  teclas: {},
  corriendo: false,
  mouse: false,             // fallback de escritorio: mouse look si no hay sensores
  pitch: 0,
  _rafId: 0, _prev: 0,
  _fovPrevio: 60,
  _size: null,
  _listo: false,

  init(renderer, scene, rig, { onUpdate, onAction, onAviso } = {}) {
    this.renderer = renderer; this.scene = scene; this.rig = rig;
    this.onUpdate = onUpdate; this.onAction = onAction; this.onAviso = onAviso;
    this.stereo = new THREE.StereoCamera();
    this.stereo.aspect = 0.5;      // per-eye aspect = camera.aspect * 0.5 (§9.7)
    this.stereo.eyeSep = IPD;
    this._size = new THREE.Vector2();
    if (this._listo) return this;
    this._listo = true;

    Cabeza.onSinSensores = motivo => {
      this.mouse = true;
      if (this.onAviso) this.onAviso(
        `No se detecta el giroscopio: ${motivo}.<br>` +
        `isSecureContext = <b>${isSecureContext}</b> · ` +
        `mirá con el mouse (click para capturarlo) o abrí <b>diag.html</b>.`);
    };

    /* Teclado. En P4 no hay locomoción de mando todavía (eso es P5), pero
       muchos mandos "VR" baratos se presentan como TECLADO (§9.10), así que
       esto ya les sirve, y en escritorio permite verificar el estéreo.
       El mapa de acciones es el de display-flat.js: cuando P5 traiga
       input.js, las dos lecturas de teclado se unifican ahí. */
    addEventListener("keydown", e => {
      if (!this.corriendo || e.repeat) return;
      this.teclas[e.code] = true;
      const acc = typeof ACCIONES !== "undefined" ? ACCIONES[e.code] : null;
      if (acc) { e.preventDefault(); if (this.onAction) this.onAction(acc); }
    });
    addEventListener("keyup", e => { this.teclas[e.code] = false; });
    addEventListener("blur", () => { this.teclas = {}; });

    // Fallback de escritorio para poder verificar el estéreo sin teléfono
    const canvas = renderer.domElement;
    canvas.addEventListener("click", () => {
      if (this.corriendo && this.mouse && document.pointerLockElement !== canvas)
        canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", e => {
      if (!this.corriendo || !this.mouse || document.pointerLockElement !== canvas) return;
      this.rig.rig.rotation.y -= e.movementX * 0.0022;              // yaw → RIG
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01,
        this.pitch - e.movementY * 0.0022));                        // pitch → CÁMARA
      this.rig.camera.rotation.set(this.pitch, 0, 0);
    });

    // Con el teléfono ya dentro del visor no se puede tocar la pantalla,
    // pero antes de ponerlo sí: doble toque = recentrar.
    canvas.addEventListener("dblclick", () => { if (this.corriendo) this.recentrar(); });
    return this;
  },

  _leerIntent() {
    const t = this.teclas, i = this.intent;
    i.move.y = (t.KeyW ? 1 : 0) - (t.KeyS ? 1 : 0);
    i.move.x = (t.KeyD ? 1 : 0) - (t.KeyA ? 1 : 0);
    i.turn = (t.KeyE ? 1 : 0) - (t.KeyQ ? 1 : 0);
    i.rise = (t.KeyR ? 1 : 0) - (t.KeyF ? 1 : 0);
    i.turbo = !!(t.ShiftLeft || t.ShiftRight);
    return i;
  },

  recentrar() {
    if (Cabeza.fuente === "sensores") Cabeza.recentrar();
    else { this.pitch = 0; this.rig.camera.rotation.set(0, 0, 0); }
  },

  start() {
    if (this.corriendo) return;
    this.corriendo = true;
    this.teclas = {};
    this._fovPrevio = this.rig.camera.fov;
    this.rig.camera.fov = FOV_CARDBOARD;
    this.rig.camera.updateProjectionMatrix();
    // La cabeza escribe la orientación desde cero: se arranca nivelado,
    // sin heredar el pitch del mouse look del modo plano.
    this.pitch = 0;
    this.rig.camera.rotation.set(0, 0, 0);
    Cabeza.activar();

    this._prev = performance.now();
    const loop = now => {
      if (!this.corriendo) return;
      this._rafId = requestAnimationFrame(loop);
      // Dos dt distintos, a propósito (trampa confirmada en P3): `crudo` es
      // el tiempo real del frame y es el que se MIDE; `dtMs` va topeado a
      // 100 ms sólo para la locomoción, para que el rig no se teletransporte
      // tras una pausa de la pestaña. No volver a unificarlos.
      const crudo = Math.max(0, now - this._prev);
      const dtMs = Math.min(100, crudo);
      this._prev = now;
      this.rig.update(this._leerIntent(), dtMs / 1000);
      if (Cabeza.fuente === "sensores") Cabeza.aplicar(this.rig.camera);
      if (this.onUpdate) this.onUpdate(crudo, now, dtMs);
      this.render();
    };
    this._rafId = requestAnimationFrame(loop);
  },

  stop() {
    if (!this.corriendo) return;
    this.corriendo = false;
    cancelAnimationFrame(this._rafId);
    Cabeza.desactivar();
    this.mouse = false;
    if (document.pointerLockElement) document.exitPointerLock();
    // devolver la cámara al estado del modo plano
    this.rig.camera.fov = this._fovPrevio;
    this.rig.camera.updateProjectionMatrix();
    this.rig.camera.quaternion.identity();
    this.rig.camera.rotation.set(this.rig.headPitch || 0, 0, 0);
    this.renderer.setScissorTest(false);
    const s = this.renderer.getSize(this._size);
    this.renderer.setViewport(0, 0, s.x, s.y);
  },

  /* Estéreo por dos viewports (§9.7).

     Los tamaños van en píxeles CSS porque setViewport/setScissor los
     multiplican por el pixelRatio internamente; getSize() devuelve
     justamente eso, así que las dos cosas son consistentes.

     OJO con el aspect: `camera.aspect` es el del canvas COMPLETO y el que
     lo divide por ojo es `stereo.aspect = 0.5` (el bundle calcula
     `camera.aspect * stereo.aspect`). Poner W/2/H acá deja la imagen
     estirada al doble. */
  render() {
    const r = this.renderer, cam = this.rig.camera;
    r.getSize(this._size);
    const W = this._size.x, H = this._size.y, w2 = Math.floor(W / 2);

    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    // la cámara es hija del rig: sin esto, stereo.update() copia una
    // matrixWorld vieja y los ojos van un frame atrás de la locomoción.
    // Se actualiza sólo la rama del rig (dos objetos), no la escena entera.
    this.rig.rig.updateMatrixWorld();
    this.stereo.update(cam);

    r.setScissorTest(true);
    r.setScissor(0, 0, w2, H); r.setViewport(0, 0, w2, H);
    r.render(this.scene, this.stereo.cameraL);
    r.setScissor(w2, 0, W - w2, H); r.setViewport(w2, 0, W - w2, H);
    r.render(this.scene, this.stereo.cameraR);
    r.setScissorTest(false);
    // Nota de medición: renderer.info se resetea al empezar cada render(),
    // así que después del frame refleja el OJO DERECHO. Eso es justo la
    // unidad del presupuesto de §9.5 ("por ojo"), no un bug.
  },

  /* Estado para el HUD y para window.__vr */
  info() {
    return {
      fov: FOV_CARDBOARD, ipd: IPD,
      cabeza: Cabeza.fuente,
      modoCabeza: Cabeza.modo,
      eventoCabeza: Cabeza.evento,
      eventos: Cabeza.eventos,
      hz: +Cabeza.hz.toFixed(1),
      absoluto: Cabeza.absoluto,
      orientPantalla: Math.round(Cabeza.orient * 180 / Math.PI),
      fullscreen: Inmersion.enFullscreen(),
      wakeLock: !!Inmersion.wakeLock,
      secureContext: isSecureContext
    };
  }
};
