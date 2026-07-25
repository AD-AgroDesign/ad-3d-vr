/* ============================================================
   rig.js — Grafo de cámara y locomoción.

       scene
       └── rig        posición + yaw  → lo escribe la LOCOMOCIÓN
           └── camera altura del ojo  → su orientación la escribe la CABEZA

   Esto NO es cosmético (HANDOFF §5.3a): en WebXR, Three sobrescribe
   camera.position y camera.quaternion con la pose del casco en cada frame.
   Si la locomoción escribiera la cámara, en Quest no funcionaría nada. Con
   el rig, los modos flat / cardboard / webxr comparten el 100 % del código
   de movimiento.

   Convención de la escena (heredada del original, main.js:388):
     X = este, Y = arriba, Z = sur.  Rumbo = grados desde el norte, horario.
     De ahí rig.rotation.y = -rumbo (en radianes): con rumbo 0 la cámara
     mira a -Z (norte), con rumbo 90 mira a +X (este).

   Regla de confort (§9.11.2): el rig SÓLO rota en yaw. El roll y el pitch
   vienen únicamente de la cabeza (mouse en flat, sensores en cardboard,
   tracking en XR). El horizonte nunca se inclina.
   ============================================================ */
"use strict";

const DEG = Math.PI / 180;

const Rig = {
  rig: null,
  camera: null,
  eyeHeight: 1.7,          // altura del ojo sobre el "piso" del rig
  modo: "dron",            // "dron" | "suelo"
  alturaDron: 18,          // §9.11.7 — default; se puede pisar por campo/query
  headPitch: 0,            // sólo lo usa el driver plano (mouse look)

  // Velocidades (§9.11.4): constantes, sin inercia. Rampa corta en el driver.
  vel: { suelo: 3.5, dron: 14 },
  velSubida: 12,
  velGiro: 90 * DEG,       // giro continuo en escritorio; en VR es snap (P5)

  init(scene, aspect) {
    this.rig = new THREE.Group();
    this.rig.name = "rig";
    // far 6000 > fin de niebla (§9.6); near chico porque en modo suelo se
    // pasa literalmente entre las matas
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 6000);
    this.camera.name = "camera";
    this.camera.position.set(0, this.eyeHeight, 0);
    this.rig.add(this.camera);
    scene.add(this.rig);
    return this;
  },

  /* --- Pose --- */
  setRumbo(deg) { this.rig.rotation.y = -deg * DEG; },
  rumbo() { return (-this.rig.rotation.y / DEG % 360 + 360) % 360; },

  /* Altura del OJO sobre el suelo (no la del rig: el ojo va eyeHeight arriba) */
  setAlturaOjo(m) { this.rig.position.y = Math.max(0, m - this.eyeHeight); },
  alturaOjo() { return this.rig.position.y + this.eyeHeight; },

  setPosicion(x, z) { this.rig.position.x = x; this.rig.position.z = z; },

  /* Altura del ojo distinta según el driver: 1,7 en flat/cardboard;
     0 en XR con local-floor, donde la altura la aporta el tracking (§9.14) */
  setEyeHeight(h) {
    const alt = this.alturaOjo();
    this.eyeHeight = h;
    this.camera.position.y = h;
    this.setAlturaOjo(alt);
  },

  /* Vista inicial: sobrevuelo del campo con el rumbo del original (15°),
     retrocedido sobre el eje de vista para que el centro del campo quede
     encuadrado. No replica el zoom de MapLibre (§9.12): es una altura
     elegida por criterio, y es un dial. */
  home(extent, opts = {}) {
    const rumbo = opts.rumbo != null ? opts.rumbo : 15;
    const alt = opts.altura != null ? opts.altura
      : Math.min(900, Math.max(180, 0.28 * Math.max(extent.ancho, extent.alto)));
    const cx = (extent.minX + extent.maxX) / 2;
    const cz = (extent.minZ + extent.maxZ) / 2;
    // Retroceso sobre la dirección de vista para que el centro caiga
    // delante: con pitch -32° (equivalente al pitch 58 de MapLibre) el
    // punto mirado está a alt/tan(32°) por delante.
    const pitch = -32 * DEG;
    const dist = alt / Math.tan(-pitch);
    const b = rumbo * DEG;
    this.setPosicion(cx - Math.sin(b) * dist, cz + Math.cos(b) * dist);
    this.setAlturaOjo(alt);
    this.setRumbo(rumbo);
    this.headPitch = pitch;
    this.camera.rotation.set(pitch, 0, 0);
    this.modo = "dron";
  },

  setModo(modo) {
    this.modo = modo;
    this.setAlturaOjo(modo === "suelo" ? this.eyeHeight : this.alturaDron);
  },
  alternarModo() { this.setModo(this.modo === "dron" ? "suelo" : "dron"); },

  /* --- Locomoción sobre el `intent` normalizado (§5.3c) ---
     move.y = avance (+1 adelante), move.x = strafe (+1 derecha),
     turn = yaw continuo, rise = subir/bajar. */
  update(intent, dt) {
    if (!intent) return;
    const th = this.rig.rotation.y;
    // adelante = (-sin θ, -cos θ); derecha = (cos θ, -sin θ)  en (x, z)
    const sin = Math.sin(th), cos = Math.cos(th);
    const v = (this.modo === "suelo" ? this.vel.suelo : this.vel.dron) * (intent.turbo ? 4 : 1);
    const mv = intent.move || { x: 0, y: 0 };
    if (mv.x || mv.y) {
      const fx = -sin * mv.y + cos * mv.x;
      const fz = -cos * mv.y - sin * mv.x;
      const len = Math.hypot(fx, fz) || 1;
      this.rig.position.x += (fx / len) * v * dt;
      this.rig.position.z += (fz / len) * v * dt;
    }
    if (intent.turn) this.rig.rotation.y -= intent.turn * this.velGiro * dt;
    if (intent.rise) {
      const alt = this.alturaOjo() + intent.rise * this.velSubida * (intent.turbo ? 4 : 1) * dt;
      this.setAlturaOjo(Math.min(2000, Math.max(this.eyeHeight, alt)));
      this.modo = this.alturaOjo() > this.eyeHeight + 0.5 ? "dron" : "suelo";
    }
  }
};
