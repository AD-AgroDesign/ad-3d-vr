/* ============================================================
   ui-menu.js — Menú del visor (P6, segunda mitad).

   Va en el DOM, espejado por ojo, con las mismas reglas que el HUD y el banner
   del tour: los dos paneles tienen que ser el MISMO objeto visual y caer en el
   centro de cada lente, o el texto no fusiona aunque la escena sí (lección de
   la segunda prueba real, §9.7).

   Por qué en el DOM y no en planos dentro de la escena, que es lo que preveía
   §9.13: decisión del dueño (2026-07-26) después de comparar las dos. Pesaron
   la NITIDEZ —el texto del DOM se dibuja a resolución nativa, y una textura
   sobre un plano, con ~557×501 px por ojo, queda blanda— y que el camino
   elegido es el cardboard, donde el DOM se ve. **Queda pendiente reevaluarlo
   con el visor puesto**; si algún día se pasa a in-world, lo que se reusa es
   el modelo de contenido de acá abajo, no el dibujo.

   Se maneja SÓLO con el mando, porque con el visor puesto no hay pantalla que
   tocar: el stick (o los botones de subir/bajar) mueven la selección, un botón
   confirma y otro vuelve. Mientras está abierto, `Input.capturado` desvía el
   stick acá y la locomoción queda quieta: si no, elegir una opción movería el
   rig al mismo tiempo.

   Y una regla que hereda del tour: **no tiene loop propio**. Lo avanza el
   driver desde su callback (§5.3b).
   ============================================================ */
"use strict";

const UMBRAL_NAV = 0.5;        // cuánto hay que mover el stick para que cuente
const REARME_NAV = 0.25;       // y volver acá abajo para que cuente otra vez
const REPETIR_MS = 380;        // repetición al mantener

const Menu = {
  abierto: false,
  ruta: [],                    // pila de submenús
  sel: 0,
  onAccion: null,
  _armado: true,
  _proxRepeticion: 0,
  _espejo: false,
  _el: null, _el2: null,

  /* --- Contenido ---
     Cada ítem: { txt, valor?, accion?, hijos? }. `valor` se recalcula al
     pintar, así que el menú siempre muestra el estado real y no una copia. */
  raiz() {
    return [
      { txt: "Paisaje", valor: () => state.scenario === "multi" ? "Multifuncional" : "Actual",
        accion: () => this._accion("paisaje") },
      { txt: "Vista", valor: () => this.poseActual || "—", accion: () => this._accion("vista") },
      { txt: "Tour", valor: () => Tour.activo ? "en curso" : "detenido",
        accion: () => this._accion("tour") },
      { txt: "Campo", valor: () => (state.campo && state.campo.nombre) || "—",
        hijos: () => ((state.cfg && state.cfg.campos) || []).map(c => ({
          txt: c.nombre, valor: () => c.id === state.campo.id ? "actual" : "",
          accion: () => this._accion("campo", c.id)
        })).concat([{ txt: "Volver", accion: () => this.volver() }]) },
      { txt: "Recentrar", accion: () => this._accion("recentrar") },
      { txt: "Salir de VR", accion: () => this._accion("salir") },
      { txt: "Cerrar", accion: () => this.cerrar() }
    ];
  },

  poseActual: "",              // la escribe app.js cuando cambia la pose

  init({ onAccion } = {}) {
    this.onAccion = onAccion;
    this._el = document.getElementById("menu");
    this._el2 = document.getElementById("menu2");
    return this;
  },

  items() {
    const nivel = this.ruta[this.ruta.length - 1];
    return nivel ? nivel() : this.raiz();
  },

  alternar() { this.abierto ? this.cerrar() : this.abrir(); },

  abrir() {
    this.abierto = true;
    this.ruta.length = 0;
    this.sel = 0;
    this._armado = false;        // el botón que abrió no cuenta como navegación
    Input.capturado = true;
    this._pintar();
  },

  cerrar() {
    this.abierto = false;
    this.ruta.length = 0;
    Input.capturado = false;
    this._pintar();
  },

  volver() {
    if (!this.ruta.length) { this.cerrar(); return; }
    this.ruta.pop();
    this.sel = 0;
    this._pintar();
  },

  /* Confirmar el ítem seleccionado: si tiene hijos, entra; si no, ejecuta. */
  confirmar() {
    const it = this.items()[this.sel];
    if (!it) return;
    if (it.hijos) { this.ruta.push(it.hijos); this.sel = 0; this._pintar(); return; }
    if (it.accion) it.accion();
    if (this.abierto) this._pintar();
  },

  mover(d) {
    const n = this.items().length;
    if (!n) return;
    this.sel = (this.sel + d + n) % n;
    this._pintar();
  },

  /* --- Navegación con el mando, una vez por frame desde el driver ---
     Umbral + rearme, igual que el snap de §9.11.3: sin el rearme, mantener el
     stick movería la selección una vez por frame. Con la repetición temporizada
     se puede mantener para recorrer una lista larga. */
  update(dtMs, now) {
    if (!this.abierto) return;
    const c = Input.crudo || { y: 0, rise: 0 };
    const v = (c.y || 0) + (c.rise || 0);          // stick adelante o botón subir
    if (Math.abs(v) < REARME_NAV) { this._armado = true; this._proxRepeticion = 0; return; }
    if (Math.abs(v) < UMBRAL_NAV) return;
    if (this._armado) {
      this._armado = false;
      this._proxRepeticion = now + REPETIR_MS * 1.6;   // primera repetición más lenta
      this.mover(v > 0 ? -1 : 1);                       // adelante/arriba = subir en la lista
    } else if (now >= this._proxRepeticion) {
      this._proxRepeticion = now + REPETIR_MS;
      this.mover(v > 0 ? -1 : 1);
    }
  },

  /* Las acciones del mando llegan por acá cuando el menú está abierto: el
     orquestador se las desvía en vez de ejecutarlas (app.js). */
  accionDeMando(acc) {
    if (acc === "menu") { this.alternar(); return true; }
    if (!this.abierto) return false;
    if (acc === "toggleScenario") { this.confirmar(); return true; }
    if (acc === "tour" || acc === "modo") { this.volver(); return true; }
    if (acc === "recenter") { this.cerrar(); return true; }
    return true;                                   // el resto no hace nada con el menú abierto
  },

  espejo(on) { this._espejo = !!on; this._pintar(); },

  _accion(id, dato) { if (this.onAccion) this.onAccion(id, dato); },

  _pintar() {
    if (!this._el) return;
    let html = "";
    if (this.abierto) {
      const its = this.items();
      html = `<div class="titulo">${this.ruta.length ? "Campo" : "Menú"}</div>` +
        its.map((it, i) => {
          const val = it.valor ? it.valor() : "";
          return `<div class="fila${i === this.sel ? " sel" : ""}">` +
            `<span class="t">${it.txt}</span>` +
            (val ? `<span class="v">${val}</span>` : "") +
            (it.hijos ? `<span class="v">›</span>` : "") + `</div>`;
        }).join("") +
        `<div class="pie">stick o subir/bajar: elegir · A: aceptar · D: volver</div>`;
    }
    for (const el of [this._el, this._el2]) {
      if (!el) continue;
      el.innerHTML = html;
      const espejado = el === this._el2 && !this._espejo;
      el.style.display = (this.abierto && !espejado) ? "block" : "none";
    }
  },

  info() {
    return { abierto: this.abierto, nivel: this.ruta.length, sel: this.sel,
             items: this.items().map(i => i.txt), capturado: !!Input.capturado };
  }
};
