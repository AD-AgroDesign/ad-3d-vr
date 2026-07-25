/* ============================================================
   perf.js — Tiers de calidad, medición y calidad adaptativa (§9.5).

   Tres responsabilidades:
   1. La tabla de diales por tier (`phone` / `quest` / `desktop`), que es el
      contrato de presupuesto del proyecto. Se elige por ?tier= o se
      autodetecta.
   2. El HUD: fps, ms/frame p95, triángulos y draw calls. El HUD del
      original sólo contaba frames; acá hace falta más, porque el
      presupuesto de VR se negocia en triángulos y draw calls POR OJO.
   3. La calidad adaptativa: si el p95 pasa el presupuesto durante 2 s se
      baja un escalón de radio; si sobra margen durante 10 s se sube uno.
      Con histéresis, porque un umbral pelado parpadea (§12.5).

   Trampas heredadas y confirmadas:
   - No medir con la pestaña oculta (§11.4): Chrome estrangula los timers y
     el original llegó a leer 8011 ms/frame. El HUD lo marca.
   - El dt que se MIDE no puede venir clampeado. En P2 el driver le pasaba
     al HUD el mismo dt topeado a 100 ms que usa la locomoción, y el p95
     saturaba en 100,0 ms exactos. Ahora el driver pasa los dos por
     separado; no volver a unificarlos.
   ============================================================ */
"use strict";

/* Diales de §9.5. `densidad`/`tope` pisan GRASS_CLASSES ANTES de generar
   los datos: cada instancia cuesta memoria y tiempo de construcción aunque
   después no se dibuje. El tier `desktop` reproduce exactamente los valores
   del proyecto original, así que los conteos de regresión siguen dando. */
const TIERS = {
  phone: {
    radioMatas: 100, radioArboles: 400, radioMax: 400,
    pasto: { "corr-herb": { densidad: 1500, tope: 40000 }, "parche-herb": { densidad: 600, tope: 25000 } },
    zoomAtlas: 17, pixelRatio: 1.0, trisObjetivo: 250000, fpsObjetivo: 60
  },
  quest: {
    radioMatas: 140, radioArboles: 600, radioMax: 800,
    pasto: { "corr-herb": { densidad: 1500, tope: 90000 }, "parche-herb": { densidad: 800, tope: 60000 } },
    zoomAtlas: 18, pixelRatio: null, trisObjetivo: 800000, fpsObjetivo: 72
  },
  desktop: {
    radioMatas: 250, radioArboles: 1200, radioMax: 3000,
    pasto: { "corr-herb": { densidad: 1500, tope: 180000 }, "parche-herb": { densidad: 800, tope: 120000 } },
    zoomAtlas: 18, pixelRatio: null, trisObjetivo: 3000000, fpsObjetivo: 60
  }
};

/* Escalones de calidad adaptativa: factor sobre los radios. El 1.0 es el
   valor nominal del tier; se baja o sube de a un escalón. */
const ESCALONES = [1.0, 0.8, 0.65, 0.5];

const Perf = {
  el: null,
  activo: false,
  tier: "desktop",
  dial: null,
  escalon: 0,
  adaptativa: true,

  muestras: [],          // ms REALES de los últimos frames
  frames: 0,
  t0: 0,
  fps: 0,
  p95: 0,
  oculta: false,
  _sobre: 0, _bajo: 0,   // acumuladores de la histéresis, en ms
  _ultimoCambio: "",

  /* Elección de tier: ?tier= manda; si no, autodetección conservadora. */
  detectarTier() {
    const pedido = params.get("tier");
    if (pedido && TIERS[pedido]) return pedido;
    if (navigator.xr && params.has("modo") && params.get("modo") === "xr") return "quest";
    const finoNo = matchMedia("(pointer: coarse)").matches;
    const chico = Math.min(innerWidth, innerHeight) < 800;
    return (finoNo && chico) ? "phone" : "desktop";
  },

  /* Se llama ANTES de loadData(): pisa los topes de generación de matas. */
  aplicarTier(tier) {
    this.tier = tier || this.detectarTier();
    this.dial = TIERS[this.tier];
    for (const [cls, v] of Object.entries(this.dial.pasto)) {
      if (!GRASS_CLASSES[cls]) continue;
      GRASS_CLASSES[cls].density = v.densidad;
      GRASS_CLASSES[cls].max = v.tope;
    }
    this.adaptativa = !params.has("sinadaptar");
    return this.dial;
  },

  radioMatas() { return this.dial.radioMatas * ESCALONES[this.escalon]; },
  radioArboles() { return this.dial.radioArboles * ESCALONES[this.escalon]; },

  /* `el2` es el espejo del HUD para el ojo derecho: en modo cardboard el
     panel de una esquina no se lee con el visor puesto, así que el mismo
     texto se pinta dos veces, una por mitad del canvas (el CSS los ubica
     en el centro de cada lente). */
  init(el, activo, el2) {
    this.el = el;
    this.el2 = el2 || null;
    this.activo = !!activo;
    if (el) el.style.display = activo ? "block" : "none";
    if (this.el2) this.el2.style.display = "none";
    this.t0 = performance.now();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.oculta = true; this.muestras.length = 0; }
    });
    return this;
  },

  /* `msFrame` tiene que ser el tiempo REAL del frame, sin clampear. */
  frame(renderer, msFrame) {
    this.muestras.push(msFrame);
    if (this.muestras.length > 180) this.muestras.shift();
    this.frames++;
    const now = performance.now();
    if (now - this.t0 < 500) return;

    this.fps = this.frames * 1000 / (now - this.t0);
    const ventana = now - this.t0;
    this.frames = 0; this.t0 = now;

    const ord = this.muestras.slice().sort((a, b) => a - b);
    this.p95 = ord.length ? ord[Math.min(ord.length - 1, Math.floor(ord.length * 0.95))] : 0;

    if (this.adaptativa && !document.hidden) this._adaptar(ventana);
    if (this.activo) this._pintar(renderer);
  },

  /* Factor del escalón de calidad adaptativa, para que Chunks lo aplique
     DESPUÉS de abrir el radio por altura (ver Chunks.radioEfectivo) */
  factorEscalon() { return ESCALONES[this.escalon]; },

  /* Calidad adaptativa con histéresis (§8/P3.5). La decisión se toma con los
     FPS contra el objetivo del tier (§9.5: phone 60, quest 72, desktop 60):
     - fps < 70 % del objetivo durante 2 s   → bajar un escalón
     - fps > 92 % del objetivo durante 10 s  → subir uno
     La banda entre el 70 % y el 92 % es el margen de §12.5: sin ella el
     sistema oscila entre dos escalones en el borde.

     ⚠️ Por qué NO se usa un presupuesto en ms, que es lo primero que se
     intenta: el ms/frame está cuantizado por el vsync. En un equipo a 60 Hz
     un frame sano dura 16,7 ms y el p95 da ≈17, así que contra un presupuesto
     de 16,7 ms la calidad adaptativa degrada hasta el piso con la máquina
     corriendo perfecta, y encima no puede recuperarse nunca porque el umbral
     de subida queda por debajo del vsync. Pasó en la primera medición en vivo.
     Estimar el vsync tampoco sirvió: la mediana se contamina cuando la app va
     lenta (marcaba 33 ms en una pantalla de 60 Hz) y el mínimo se envenena con
     un frame corto suelto (marcaba 6,6 ms). Los fps ya vienen promediados por
     ventana y no tienen ninguno de los dos problemas. */
  _adaptar(ventanaMs) {
    const objetivo = this.dial.fpsObjetivo;
    if (this.fps < objetivo * 0.70) { this._sobre += ventanaMs; this._bajo = 0; }
    else if (this.fps > objetivo * 0.92) { this._bajo += ventanaMs; this._sobre = 0; }
    else { this._sobre = 0; this._bajo = 0; }

    const previo = this.escalon;
    if (this._sobre >= 2000 && this.escalon < ESCALONES.length - 1) {
      this.escalon++; this._sobre = 0;
      this._ultimoCambio = `↓ escalón ${this.escalon} (p95 ${this.p95.toFixed(1)} ms)`;
    } else if (this._bajo >= 10000 && this.escalon > 0) {
      this.escalon--; this._bajo = 0;
      this._ultimoCambio = `↑ escalón ${this.escalon} (p95 ${this.p95.toFixed(1)} ms)`;
    }
    // el radio cambió: que la revisión de visibilidad no espere los 200 ms
    if (this.escalon !== previo && typeof Chunks !== "undefined") Chunks.invalidar();
  },

  /* Línea extra que el driver de turno puede escribir (p. ej. el estado de
     la cabeza en cardboard). No la toca Perf: sólo la pinta. */
  linea: "",

  _pintar(renderer) {
    const r = renderer.info.render;
    const exceso = r.triangles > this.dial.trisObjetivo;
    // En estéreo renderer.info se resetea en cada render(), así que estos
    // números son los del ÚLTIMO ojo dibujado: la unidad correcta del
    // presupuesto de §9.5, que es "por ojo".
    const html =
      `<b>${this.fps.toFixed(0)}</b> fps · p95 ${this.p95.toFixed(1)} ms<br>` +
      `<span class="${exceso ? "warn" : ""}">${(r.triangles / 1000).toFixed(0)} k tris</span>` +
      ` · ${r.calls} draw calls<br>` +
      `tier <b>${this.tier}</b> · escalón ${this.escalon} · R ${Math.round(Chunks.radioEfectivoMatas())} m` +
      ` · objetivo ${this.dial.fpsObjetivo} fps` +
      (this.linea ? `<br>${this.linea}` : "") +
      (this._ultimoCambio ? `<br><span class="warn">${this._ultimoCambio}</span>` : "") +
      (this.oculta ? '<br><span class="warn">hubo pestaña oculta: fps no confiable</span>' : "");
    this.el.innerHTML = html;
    if (this.el2 && this.el2.style.display !== "none") this.el2.innerHTML = html;
  },

  /* Enciende o apaga el espejo del ojo derecho (lo llama el driver) */
  espejo(on) {
    if (this.el2) this.el2.style.display = (on && this.activo) ? "block" : "none";
  },

  snapshot(renderer) {
    const r = renderer.info.render;
    return {
      tier: this.tier, escalon: this.escalon,
      radioMatas: this.radioMatas(), radioArboles: this.radioArboles(),
      radioEfectivo: +Chunks.radioEfectivoMatas().toFixed(0),
      fps: +this.fps.toFixed(1), p95: +this.p95.toFixed(2), fpsObjetivo: this.dial.fpsObjetivo,
      triangulos: r.triangles, drawCalls: r.calls,
      trisObjetivo: this.dial.trisObjetivo,
      dentroDePresupuesto: r.triangles <= this.dial.trisObjetivo,
      pestanaOculta: this.oculta
    };
  }
};
