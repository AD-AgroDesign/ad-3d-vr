/* ============================================================
   input.js — Todas las fuentes de entrada normalizadas a un `intent` (§5.3c).

   Fuentes: gamepad (mando Bluetooth y, en P7, los controles del Quest),
   teclado (escritorio, y los mandos baratos que se presentan COMO teclado) y
   mouse. La locomoción de `rig.js` no sabe de dónde viene nada:

     intent = { move:{x,y}, turn, rise, turbo }        // continuo, por frame
     acciones → callback onAction("toggleScenario" | "recenter" | …)

   Antes de este archivo, los dos drivers de display tenían su propia copia de
   la lectura de teclado. Acá se unifica: los drivers sólo llaman `Input.leer()`.

   ⚠️ EL MAPEO NO SE ADIVINA (§9.10). El perfil del mando del dueño salió del
   "Mapeo guiado" de `input-test.html` corrido en su teléfono el 2026-07-26.
   Para agregar otro mando: correr esa página y volcar el resultado acá.
   ============================================================ */
"use strict";

const DEADZONE = 0.18;        // §9.10: zona muerta de 0,15–0,20
const LARGO_MS = 800;         // pulsación "larga" (acción secundaria)
const SNAP_UMBRAL = 0.55;     // el eje tiene que pasar de acá para disparar el snap
const SNAP_REARME = 0.30;     // y volver acá abajo para poder disparar otra vez

/* ---------- Perfiles de mando ----------

   `ONSET VR Control Mouse` (Vendor 05ac Product 3232), 17 botones, 4 ejes,
   `mapping` vacío. Todo lo de abajo está MEDIDO, y varias cosas son
   contraintuitivas:

   - **El eje 0 es el de avance y el 1 el de giro**, al revés del mapeo
     estándar (donde axes[0] es el horizontal). Los dos con signo negativo:
     avanzar es eje 0 en −1, girar a la derecha es eje 1 en −1.
   - **Los botones 3 y 4 son fantasma**: son la misma bandera espejada (cuando
     uno baja el otro sube) y cambian de estado con cualquier pulsación real.
     No son botones físicos y hay que ignorarlos, o la app parece tener una
     tecla trabada. Confirmado en tres logs distintos.
   - **Botones reales: 0, 1, 2 y 5.** Son cuatro, así que las acciones
     secundarias van por pulsación LARGA (§9.10 ya lo proponía para recentrar).
     El dueño mapeó `tour` y `modo` al mismo botón y `recentrar` cayó sobre el
     fantasma: con cuatro botones no alcanzaba, y esta es la asignación que
     respeta lo que eligió sin dejar nada sin acceso.
   - El mismo mando, según cómo se enciende, se presenta como MOUSE (sin
     gamepad) o expone el stick como botones de D-pad. El perfil cubre los dos
     casos: si aparecen 12/13/14/15, valen como stick digital. */
const PERFILES = [
  {
    nombre: "ONSET VR Control Mouse",
    coincide: id => /onset|05ac.*3232/i.test(id),
    ejes: { avance: { eje: 0, signo: -1 }, giro: { eje: 1, signo: -1 } },
    /* Cuando el stick sale como botones (otro modo de encendido del mando) */
    dpad: { adelante: 12, atras: 13, izquierda: 14, derecha: 15 },
    botones: {
      5: { corto: "toggleScenario", largo: "recenter" },
      0: { corto: "tour", largo: "modo" },
      2: { mantener: "subir" },
      1: { mantener: "bajar" }
    },
    ignorar: [3, 4]
  },
  {
    /* Mapeo estándar (Xbox/Touch/DualShock): el que se va a encontrar en el
       Quest en P7. Acá sí valen los índices del estándar. */
    nombre: "estándar",
    coincide: (id, gp) => gp.mapping === "standard",
    ejes: { avance: { eje: 1, signo: -1 }, giro: { eje: 2, signo: 1 } },
    dpad: { adelante: 12, atras: 13, izquierda: 14, derecha: 15 },
    botones: {
      0: { corto: "toggleScenario" },
      1: { corto: "recenter" },
      2: { corto: "tour" },
      3: { corto: "modo" },
      9: { corto: "menu" },
      7: { mantener: "subir" },
      6: { mantener: "bajar" }
    },
    ignorar: []
  }
];

/* Perfil de último recurso: sin `mapping` ni id conocido, se usan los dos
   primeros ejes y los cuatro primeros botones, y se avisa. */
const PERFIL_CIEGO = {
  nombre: "desconocido",
  coincide: () => true,
  ejes: { avance: { eje: 1, signo: -1 }, giro: { eje: 0, signo: 1 } },
  dpad: { adelante: 12, atras: 13, izquierda: 14, derecha: 15 },
  botones: {
    0: { corto: "toggleScenario", largo: "recenter" },
    1: { corto: "tour", largo: "modo" },
    2: { mantener: "subir" },
    3: { mantener: "bajar" }
  },
  ignorar: []
};

/* Mapeo de teclado. Se mantiene el del proyecto (§9.10) para que escritorio y
   los mandos en modo teclado caigan sobre las mismas acciones. */
const ACCIONES_TECLA = {
  Space: "toggleScenario",
  KeyC: "recenter",
  KeyT: "tour",
  KeyG: "modo",
  KeyH: "home",
  KeyM: "menu"
};

const Input = {
  onAction: null,
  perfil: null,
  gamepadId: null,
  teclas: {},
  intent: { move: { x: 0, y: 0 }, turn: 0, rise: 0, turbo: false },
  /* Giro CONTINUO por default, decisión del dueño tras probar las dos
     variantes (2026-07-26): «con esos saltos de ±30° se hace rara la
     navegación». §9.11.3 recomendaba snap, y sigue disponible con ?giro=snap;
     §12.4: cuando el dueño elige entre dos variantes, la elección manda.
     El límite de velocidad de giro y la rampa viven en rig.js. */
  giroContinuo: true,       // ?giro=snap para volver al snap de ±30°
  _btn: {},                 // índice → { abajo, t0, largoHecho }
  _esperandoSoltar: null,   // botones pulsados al aparecer el mando
  _snapArmado: true,
  _avisado: false,

  init({ onAction } = {}) {
    this.onAction = onAction;
    if (params.get("giro") === "snap") this.giroContinuo = false;
    if (params.get("giro") === "continuo") this.giroContinuo = true;
    /* Modo calibración (`?calib`): el horizontal del stick deja de girar y pasa
       a ajustar la separación de imágenes. Existe porque la separación buena
       DEPENDE DEL DISPOSITIVO — el dueño lo comprobó: en otro teléfono
       necesitó unos píxeles más — y con el visor puesto no se puede tocar la
       pantalla, pero sí se puede usar el mando. Se abre esta URL una vez por
       dispositivo, se ajusta hasta que las dos vistas fusionan, y el valor
       queda recordado. */
    this.calib = params.has("calib");

    addEventListener("keydown", e => {
      if (e.repeat) return;
      this.teclas[e.code] = true;
      const acc = ACCIONES_TECLA[e.code];
      if (acc) { e.preventDefault(); this._accion(acc); }
      // el giro por teclado también es snap, salvo que se pida continuo
      if (!this.giroContinuo) {
        if (e.code === "KeyQ") this._accion("snapIzq");
        if (e.code === "KeyE") this._accion("snapDer");
      }
    });
    addEventListener("keyup", e => { this.teclas[e.code] = false; });
    addEventListener("blur", () => { this.teclas = {}; });

    addEventListener("gamepadconnected", e => {
      // Los botones que ya vienen pulsados al conectar se ignoran HASTA QUE SE
      // SUELTEN una vez. Medido: en este mando el botón que llega pulsado
      // CAMBIA entre sesiones (fue el 3 una vez y el 12 otra, y el 12 es real),
      // así que descartarlos para siempre rompería hardware bueno.
      this._esperandoSoltar = new Set();
      const gp = e.gamepad;
      gp.buttons.forEach((b, i) => { if (b.pressed) this._esperandoSoltar.add(i); });
      this.perfil = null;   // se re-elige con el id del mando nuevo
      console.log(`mando conectado: "${gp.id}" · ${gp.buttons.length} botones · ` +
        `${gp.axes.length} ejes · mapping "${gp.mapping}"`);
    });
    return this;
  },

  _accion(acc) { if (acc && this.onAction) this.onAction(acc); },

  _elegirPerfil(gp) {
    this.perfil = PERFILES.find(p => p.coincide(gp.id, gp)) || PERFIL_CIEGO;
    this.gamepadId = gp.id;
    if (this.perfil === PERFIL_CIEGO && !this._avisado) {
      this._avisado = true;
      console.warn(`mando "${gp.id}" sin perfil: se usa el genérico. ` +
        `Corré input-test.html → "Mapeo guiado" y agregá el perfil a input.js.`);
    }
    return this.perfil;
  },

  /* Zona muerta con reescalado: sin el reescalado, el primer movimiento útil
     del stick salta de 0 a 0,18 y se siente como un tirón. */
  _eje(v) {
    const a = Math.abs(v);
    if (a < DEADZONE) return 0;
    return Math.sign(v) * (a - DEADZONE) / (1 - DEADZONE);
  },

  /* Estado de un botón, con detección de flanco y pulsación larga.
     La acción corta se dispara al SOLTAR (no al pulsar): es la única forma de
     que un botón pueda tener acción corta y larga sin disparar las dos. */
  _botones(gp, p) {
    let rise = 0;
    for (const [idxTxt, mapa] of Object.entries(p.botones)) {
      const i = +idxTxt;
      const b = gp.buttons[i];
      if (!b) continue;
      if (p.ignorar.includes(i)) continue;
      let st = this._btn[i];
      if (!st) st = this._btn[i] = { abajo: false, t0: 0, largoHecho: false };

      // el que venía pulsado al conectar no cuenta hasta que se suelte
      if (this._esperandoSoltar && this._esperandoSoltar.has(i)) {
        if (!b.pressed) this._esperandoSoltar.delete(i);
        continue;
      }

      const ahora = performance.now();
      if (b.pressed && !st.abajo) { st.abajo = true; st.t0 = ahora; st.largoHecho = false; }
      else if (b.pressed && st.abajo) {
        if (mapa.largo && !st.largoHecho && ahora - st.t0 >= LARGO_MS) {
          st.largoHecho = true;               // dispara ya, sin esperar el soltar
          this._accion(mapa.largo);
        }
      } else if (!b.pressed && st.abajo) {
        st.abajo = false;
        if (mapa.corto && !st.largoHecho) this._accion(mapa.corto);
      }
      if (mapa.mantener === "subir" && b.pressed) rise += 1;
      if (mapa.mantener === "bajar" && b.pressed) rise -= 1;
    }
    return rise;
  },

  /* Stick expuesto como botones de D-pad (otro modo de encendido del mando) */
  _dpad(gp, p) {
    const on = i => { const b = gp.buttons[i]; return !!(b && b.pressed) && !p.ignorar.includes(i); };
    const d = p.dpad || {};
    return {
      y: (on(d.adelante) ? 1 : 0) - (on(d.atras) ? 1 : 0),
      x: (on(d.derecha) ? 1 : 0) - (on(d.izquierda) ? 1 : 0)
    };
  },

  /* Se llama una vez por frame desde el driver de display. */
  leer() {
    const i = this.intent, t = this.teclas;

    /* --- teclado (escritorio y mandos en modo teclado) --- */
    let mvY = (t.KeyW ? 1 : 0) - (t.KeyS ? 1 : 0);
    let mvX = (t.KeyD ? 1 : 0) - (t.KeyA ? 1 : 0);
    let turn = this.giroContinuo ? (t.KeyE ? 1 : 0) - (t.KeyQ ? 1 : 0) : 0;
    let rise = (t.KeyR ? 1 : 0) - (t.KeyF ? 1 : 0);
    let turbo = !!(t.ShiftLeft || t.ShiftRight);

    /* --- gamepad --- */
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) {
      if (!gp || !gp.connected) continue;
      const p = (this.perfil && this.gamepadId === gp.id) ? this.perfil : this._elegirPerfil(gp);

      const ejeAv = this._eje((gp.axes[p.ejes.avance.eje] || 0) * p.ejes.avance.signo);
      const ejeGiro = this._eje((gp.axes[p.ejes.giro.eje] || 0) * p.ejes.giro.signo);
      const dp = this._dpad(gp, p);

      if (ejeAv) mvY = ejeAv; else if (dp.y) mvY = dp.y;

      /* Giro: snap por defecto (§9.11.3 — el giro continuo por mando es la
         causa número uno de mareo). El eje tiene que pasar el umbral y volver
         a la zona de rearme para disparar de nuevo: sin el rearme, mantener el
         stick al costado dispararía un snap por frame.

         El horizontal del mando gira, NO hace strafe: con un solo stick el giro
         es lo que hace falta, y el strafe queda para el teclado. Los dos casos
         (eje analógico y D-pad) entran por el mismo umbral, porque un botón
         visto como eje va 0 → ±1 → 0 y cruza igual. */
      const vGiro = ejeGiro || dp.x;
      if (this.calib) {
        // en calibración el horizontal ajusta la separación, con el mismo
        // umbral + rearme del snap (un paso por movimiento, no uno por frame)
        if (this._snapArmado && Math.abs(vGiro) > SNAP_UMBRAL) {
          this._snapArmado = false;
          this._accion(vGiro > 0 ? "sepMas" : "sepMenos");
        } else if (!this._snapArmado && Math.abs(vGiro) < SNAP_REARME) {
          this._snapArmado = true;
        }
      } else if (this.giroContinuo) {
        if (vGiro) turn = vGiro;
      } else {
        const v = vGiro;
        if (this._snapArmado && Math.abs(v) > SNAP_UMBRAL) {
          this._snapArmado = false;
          this._accion(v > 0 ? "snapDer" : "snapIzq");
        } else if (!this._snapArmado && Math.abs(v) < SNAP_REARME) {
          this._snapArmado = true;
        }
      }

      const riseBtn = this._botones(gp, p);
      if (riseBtn) rise = riseBtn;
    }

    i.move.x = mvX; i.move.y = mvY;
    i.turn = turn; i.rise = rise; i.turbo = turbo;
    return i;
  },

  info() {
    const gps = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter(Boolean);
    return {
      perfil: this.perfil ? this.perfil.nombre : null,
      mando: this.gamepadId,
      mandos: gps.length,
      giro: this.giroContinuo ? "continuo" : "snap",
      calibrando: !!this.calib,
      esperandoSoltar: this._esperandoSoltar ? [...this._esperandoSoltar] : []
    };
  }
};
