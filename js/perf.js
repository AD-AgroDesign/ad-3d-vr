/* ============================================================
   perf.js — HUD de medición (versión mínima de P2; P3 la extiende con
   tiers y calidad adaptativa, §9.5).

   Muestra fps, ms/frame p95, triángulos y draw calls. El HUD del original
   sólo contaba frames; acá hace falta más, porque el presupuesto de VR se
   negocia en triángulos y draw calls POR OJO.

   Trampa heredada (§11.4): no medir con la pestaña oculta. Chrome
   estrangula los timers y el proyecto original llegó a leer 8011 ms/frame.
   Por eso el HUD marca cuando la pestaña estuvo oculta.
   ============================================================ */
"use strict";

const Perf = {
  el: null,
  activo: false,
  muestras: [],          // ms de los últimos frames
  frames: 0,
  t0: 0,
  fps: 0,
  oculta: false,

  init(el, activo) {
    this.el = el;
    this.activo = !!activo;
    if (el) el.style.display = activo ? "block" : "none";
    this.t0 = performance.now();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.oculta = true; this.muestras.length = 0; }
    });
    return this;
  },

  frame(renderer, dtMs) {
    if (!this.activo) return;
    this.frames++;
    this.muestras.push(dtMs);
    if (this.muestras.length > 180) this.muestras.shift();
    const now = performance.now();
    if (now - this.t0 < 500) return;
    this.fps = this.frames * 1000 / (now - this.t0);
    this.frames = 0; this.t0 = now;

    const ord = this.muestras.slice().sort((a, b) => a - b);
    const p95 = ord.length ? ord[Math.min(ord.length - 1, Math.floor(ord.length * 0.95))] : 0;
    const r = renderer.info.render;
    this.el.innerHTML =
      `<b>${this.fps.toFixed(0)}</b> fps · p95 ${p95.toFixed(1)} ms<br>` +
      `${(r.triangles / 1000).toFixed(0)} k tris · ${r.calls} draw calls` +
      (this.oculta ? '<br><span class="warn">hubo pestaña oculta: fps no confiable</span>' : "");
  },

  snapshot(renderer) {
    const r = renderer.info.render;
    const ord = this.muestras.slice().sort((a, b) => a - b);
    return {
      fps: +this.fps.toFixed(1),
      p95: ord.length ? +ord[Math.floor(ord.length * 0.95)].toFixed(2) : null,
      triangulos: r.triangles, drawCalls: r.calls,
      pestanaOculta: this.oculta
    };
  }
};
