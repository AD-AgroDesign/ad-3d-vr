/* ============================================================
   display-flat.js — Driver de display MONO para escritorio (§5.3b).

   Es el modo de desarrollo y de verificación automatizada: mouse look con
   pointer lock, WASD, y el loop con requestAnimationFrame. Los otros dos
   drivers (cardboard en P4, webxr en P7) implementan la misma interfaz
   mínima —init/start/stop/render/label— sobre el MISMO rig, así que la
   locomoción no se reescribe.

   Reparto de rotaciones (regla de confort §9.11.2): el mouse en X escribe
   el YAW DEL RIG y en Y el PITCH DE LA CÁMARA. El horizonte nunca se
   inclina, y en cardboard/XR el pitch lo pasa a escribir la cabeza real
   sin tocar nada más.

   El teclado ya usa el mapeo propuesto en §9.10 para el mando, así que
   cuando en P5 aparezca el gamepad sólo cambia la FUENTE del `intent`.
   ============================================================ */
"use strict";

const DisplayFlat = {
  label: "flat",
  renderer: null, scene: null, rig: null,
  onUpdate: null, onAction: null,
  intent: { move: { x: 0, y: 0 }, turn: 0, rise: 0, turbo: false },
  teclas: {},
  corriendo: false,
  _rafId: 0,
  _prev: 0,
  pitch: 0,

  init(renderer, scene, rig, { onUpdate, onAction } = {}) {
    this.renderer = renderer; this.scene = scene; this.rig = rig;
    this.onUpdate = onUpdate; this.onAction = onAction;
    this.pitch = rig.headPitch || 0;

    const canvas = renderer.domElement;
    canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", e => {
      if (document.pointerLockElement !== canvas) return;
      rig.rig.rotation.y -= e.movementX * 0.0022;                 // yaw → RIG
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01,
        this.pitch - e.movementY * 0.0022));                      // pitch → CÁMARA
      rig.camera.rotation.set(this.pitch, 0, 0);
    });

    addEventListener("keydown", e => {
      if (e.repeat) return;
      this.teclas[e.code] = true;
      const acc = ACCIONES[e.code];
      if (acc) { e.preventDefault(); if (this.onAction) this.onAction(acc); }
    });
    addEventListener("keyup", e => { this.teclas[e.code] = false; });
    addEventListener("blur", () => { this.teclas = {}; });
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

  start() {
    if (this.corriendo) return;
    this.corriendo = true;
    this._prev = performance.now();
    const loop = now => {
      if (!this.corriendo) return;
      this._rafId = requestAnimationFrame(loop);
      // Dos dt distintos, a propósito:
      // - `crudo` es el tiempo real del frame y es el que se MIDE. Clamparlo
      //   antes de medirlo censura los frames lentos y hace que el p95 sature
      //   en el valor del tope (bug real: el HUD marcaba 100,0 ms exactos).
      // - `dtMs` va topeado a 100 ms sólo para la LOCOMOCIÓN, para que el rig
      //   no se teletransporte tras una pausa larga de la pestaña.
      // El Math.max(0, ...) es por el quirk de rAF de §11.4.
      const crudo = Math.max(0, now - this._prev);
      const dtMs = Math.min(100, crudo);
      this._prev = now;
      this.rig.update(this._leerIntent(), dtMs / 1000);
      if (this.onUpdate) this.onUpdate(crudo, now, dtMs);
      this.render();
    };
    this._rafId = requestAnimationFrame(loop);
  },

  stop() { this.corriendo = false; cancelAnimationFrame(this._rafId); },

  render() { this.renderer.render(this.scene, this.rig.camera); }
};

/* Mapeo de teclado: el mismo de la tabla de §9.10, para que el mando del
   dueño caiga sobre las mismas acciones cuando llegue P5 */
const ACCIONES = {
  Space: "toggleScenario",
  KeyC: "recenter",
  KeyT: "tour",
  KeyG: "modo",
  KeyH: "home",
  KeyM: "menu"
};
