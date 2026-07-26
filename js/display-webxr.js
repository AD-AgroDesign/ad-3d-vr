/* ============================================================
   display-webxr.js — Driver de display WEBXR (P7, adelantado).

   ⚠️ ESTO NO REEMPLAZA AL CARDBOARD. El driver de `display-cardboard.js`
   funciona, está medido y el dueño lo ACEPTÓ el 2026-07-26 («funciona a la
   perfección y la navegabilidad es muy buena»). Este archivo es un driver
   ALTERNATIVO que se abre con el botón "Probar WebXR" (o con ?modo=xr) y que
   no toca ni el rig, ni el input, ni la configuración aprobada: si no
   convence, se descarta el archivo y no se perdió nada (§5.3b).

   Por qué se adelantó la fase: en el teléfono del dueño
   `requestSession("immersive-vr")` ABRE de verdad, con `local-floor` y un
   framebuffer de 1614×756 (≈807×756 por ojo, 2,2× los píxeles del cardboard
   casero). Si eso se sostiene, resuelve de un golpe las tres cosas que hoy
   están abiertas o parcheadas a mano:
     1. la FUSIÓN estéreo — la separación la pone el runtime, que conoce el
        perfil del visor, en vez del dial `?sep=` calibrado a ojo;
     2. la DISTORSIÓN DE BARRIL — hoy no existe (§9.7, postergada a P8);
     3. el HEAD TRACKING — la pose la entrega el runtime y no el
        `deviceorientation` de 17–25 Hz que obligó a predecir en P4.

   Tres detalles del contrato de WebXR que hay que respetar (§9.14):
   - `renderer.setAnimationLoop` es OBLIGATORIO: el rAF tiene que ser el de la
     sesión. Un requestAnimationFrame propio no se sincroniza con el visor.
   - La cámara la maneja el runtime: `camera.position`/`quaternion` se
     sobrescriben en cada frame. Por eso toda la locomoción va al rig (§5.3a),
     que es exactamente como está escrito `rig.js` desde P2. Cero cambios.
   - Con `local-floor` el piso es y = 0 y la altura del ojo la aporta el
     tracking: la altura del ojo del rig pasa a 0 para no sumar 1,7 dos veces.

   Y una limitación que hay que tener presente al leer los resultados: DENTRO
   de la sesión el DOM no se ve (no hay dom-overlay en immersive-vr), así que
   el HUD de `perf.js` queda invisible. Por eso este driver MIDE durante la
   sesión y escribe un REPORTE al salir, que es lo que el dueño puede leer y
   copiar. Un HUD in-world es P6.
   ============================================================ */
"use strict";

/* `local-floor` es el que queremos (piso real a y=0). Si el runtime no lo da,
   se cae a `local` y la altura del ojo vuelve a ser la de software. Los dos se
   probaron OK en el teléfono del dueño (volcado de diag.html, 2026-07-26). */
const XR_REFS = ["local-floor", "local", "viewer"];

const DisplayWebXR = {
  label: "webxr",
  renderer: null, scene: null, rig: null,
  onUpdate: null, onAction: null, onAviso: null, onSalir: null,
  corriendo: false,
  session: null,
  tipoRef: null,            // el reference space que concedió el runtime
  soporte: null,            // resultado cacheado de isSessionSupported
  reporte: null,            // último reporte de sesión (texto plano)
  _prev: 0,
  _previo: null,            // estado del rig/cámara a restaurar al salir
  _muestreo: 0,
  _fovVigneta: 0,

  init(renderer, scene, rig, { onUpdate, onAction, onAviso, onSalir } = {}) {
    this.renderer = renderer; this.scene = scene; this.rig = rig;
    this.onUpdate = onUpdate; this.onAction = onAction;
    this.onAviso = onAviso; this.onSalir = onSalir;
    return this;
  },

  /* ¿Se puede pedir la sesión? Se consulta una vez y se cachea: es lo que
     decide si el botón "Probar WebXR" aparece.

     OJO con la lectura del resultado: en el teléfono del dueño esto dio `true`
     ya en la primera prueba (2026-07-25) contra lo que asumía §5.1, pero
     `isSessionSupported` NO es prueba de nada — sólo pedir la sesión de verdad
     lo confirma, y eso necesita un gesto del usuario. */
  async disponible() {
    if (this.soporte !== null) return this.soporte;
    if (!navigator.xr || !navigator.xr.isSessionSupported) { this.soporte = false; return false; }
    try { this.soporte = await navigator.xr.isSessionSupported("immersive-vr"); }
    catch (e) { this.soporte = false; }
    return this.soporte;
  },

  /* Pide la sesión. TIENE que llamarse desde el gesto del usuario.

     Devuelve { ok, motivo } en vez de tirar: el fallo acá es un resultado
     esperado y hay que poder mostrárselo al dueño en pantalla, que es la
     única forma de saber POR QUÉ no abrió en su dispositivo. */
  async entrar() {
    if (this.session) return { ok: true, motivo: "ya había una sesión abierta" };
    if (!navigator.xr) return { ok: false, motivo: "este navegador no expone navigator.xr" };
    if (!isSecureContext) return { ok: false, motivo: "la página no está en contexto seguro (HTTPS)" };

    let session;
    try {
      session = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"]
      });
    } catch (e) {
      return { ok: false, motivo: (e && (e.name + ": " + e.message)) || String(e) };
    }

    /* Qué reference space concedió de verdad. Se prueba a mano en vez de
       confiar en setReferenceSpaceType, porque si el pedido falla three
       rechaza la promesa entera y perderíamos la sesión ya abierta. */
    this.tipoRef = null;
    for (const t of XR_REFS) {
      try { await session.requestReferenceSpace(t); this.tipoRef = t; break; }
      catch (e) { /* probar el siguiente */ }
    }
    if (!this.tipoRef) {
      try { await session.end(); } catch (e) {}
      return { ok: false, motivo: "el runtime no concede ningún reference space" };
    }

    this.session = session;
    session.addEventListener("end", () => this._fin("la terminó el visor o el usuario"));

    // Escala del framebuffer: ?fbs=<n>. Es el dial de nitidez contra fps del
    // lado de XR (el equivalente de ?pr= en cardboard) y hay que fijarlo ANTES
    // de setSession, que es cuando three crea la XRWebGLLayer.
    const fbs = params.has("fbs") ? Math.max(0.4, Math.min(2, +params.get("fbs"))) : null;
    if (fbs) this.renderer.xr.setFramebufferScaleFactor(fbs);
    this._fbsPedido = fbs;

    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(this.tipoRef);
    try {
      await this.renderer.xr.setSession(session);
    } catch (e) {
      this.session = null;
      try { await session.end(); } catch (e2) {}
      return { ok: false, motivo: "three no pudo tomar la sesión: " + ((e && e.message) || e) };
    }
    // Foveado: gratis en Quest, ignorado donde no existe (§9.14)
    try { this.renderer.xr.setFoveation(1); } catch (e) {}
    return { ok: true, motivo: "" };
  },

  /* Termina la sesión. El resto (restaurar el rig, volver al driver plano,
     escribir el reporte) lo hace el handler de `end`, que es el único camino
     que también cubre cuando la corta el visor. */
  async salir() {
    if (!this.session) return;
    this._motivoFin = "la cerró el usuario";
    try { await this.session.end(); } catch (e) { this._fin("error al cerrar: " + e); }
  },

  start() {
    if (this.corriendo || !this.session) return;
    this.corriendo = true;

    /* Estado a restaurar. En XR la proyección y la pose las escribe el
       runtime, así que el fov y la orientación de software no se usan — pero
       si no se guardan, al volver al modo plano la cámara queda con lo último
       que dejó el runtime. */
    const cam = this.rig.camera;
    this._previo = {
      eyeHeight: this.rig.eyeHeight,
      fov: cam.fov,
      aspect: cam.aspect,
      pixelRatio: this.renderer.getPixelRatio()
    };

    /* Con local-floor el piso está en y=0 y la altura del ojo la pone el
       tracking: si dejáramos eyeHeight en 1,7 la sumaríamos dos veces (§9.14).
       setEyeHeight conserva la altura de vuelo, así que se entra a XR a la
       misma altura a la que se estaba mirando. */
    this.rig.setEyeHeight(this.tipoRef === "local-floor" ? 0 : 1.7);
    this.rig.nivelar();          // el pitch de software no manda más

    // El mando del Quest (y cualquier control de la sesión) entra por el mismo
    // camino que el mando Bluetooth: input.js lee esta fuente extra y aplica
    // el perfil `xr-standard`. El teclado y el gamepad del sistema siguen igual.
    Input.gamepadsExtra = () => this._gamepadsXR();

    this._medidas = {
      inicio: performance.now(), fin: 0, frames: 0,
      fpsSuma: 0, fpsN: 0, fpsMin: Infinity, p95Max: 0,
      tris: 0, calls: 0, framebuffer: null, viewport: null,
      ipd: null, fovY: null, aspectOjo: null,
      mandos: {}, motivo: ""
    };
    this._muestreo = 0;
    this._fovVigneta = 0;
    this._prev = performance.now();

    /* El loop de la SESIÓN, no el del documento (§9.14). El callback recibe
       (tiempo, XRFrame); el XRFrame es lo que permite leer la pose de la
       cabeza antes de dibujar. */
    this.renderer.setAnimationLoop((t, frame) => {
      if (!this.corriendo) return;
      const now = performance.now();
      // Los dos dt de siempre: `crudo` se MIDE, `dtMs` (topeado) mueve el rig.
      // No volver a unificarlos (trampa confirmada en P3).
      const crudo = Math.max(0, now - this._prev);
      const dtMs = Math.min(100, crudo);
      this._prev = now;

      /* La pose de la cabeza se escribe ANTES de render(). three la escribe
         igual dentro de render(), pero lo hace DESPUÉS de que la escena
         actualizó sus matrices: los hijos de la cámara —la viñeta— quedarían
         un frame atrasados respecto de la cabeza, que es justo el tipo de
         judder que se ve en la periferia al girar. Escribirla acá cuesta una
         lectura y deja todo en fase. */
      this._pose(frame);

      this.rig.update(Input.leer(), dtMs / 1000);
      Vigneta.update(this.rig, dtMs);
      if (this.onUpdate) this.onUpdate(crudo, now, dtMs);
      this.render();
      this._medir(now);
    });
  },

  stop() {
    if (!this.corriendo) return;
    this.corriendo = false;
    this.renderer.setAnimationLoop(null);
    this.renderer.xr.enabled = false;
    Input.gamepadsExtra = null;

    const cam = this.rig.camera;
    if (this._previo) {
      this.rig.setEyeHeight(this._previo.eyeHeight);
      cam.fov = this._previo.fov;
      cam.aspect = this._previo.aspect;
      // mientras presentaba, el renderer dibujaba contra el framebuffer del
      // visor: se devuelve el pixelRatio que negoció `?pr=` / el tier
      this.renderer.setPixelRatio(this._previo.pixelRatio);
      this._previo = null;
    }
    cam.quaternion.identity();
    cam.rotation.set(this.rig.headPitch || 0, 0, 0);
    cam.updateProjectionMatrix();
    // El renderer vuelve al tamaño del documento: mientras presentaba, setSize
    // no tenía efecto y el canvas quedó con el del framebuffer del visor.
    if (innerWidth > 0 && innerHeight > 0) {
      this.renderer.setSize(innerWidth, innerHeight, false);
      cam.aspect = innerWidth / innerHeight;
      cam.updateProjectionMatrix();
    }
    Vigneta.ajustar(cam, cam.aspect);
  },

  render() { this.renderer.render(this.scene, this.rig.camera); },

  /* --- Pose de la cabeza desde el XRFrame ---
     Se escribe en la MATRIZ LOCAL de la cámara, que es exactamente lo que hace
     three (copia la matriz local de su ArrayCamera). La cámara es hija del
     rig, así que la pose queda relativa al rig y la locomoción se compone
     sola: es la razón de ser del grafo de §5.3a. */
  _pose(frame) {
    const ref = this.renderer.xr.getReferenceSpace();
    if (!frame || !ref || !frame.getViewerPose) return false;
    const pose = frame.getViewerPose(ref);
    if (!pose) return false;                 // pasa: el runtime aún no trackea
    const cam = this.rig.camera;
    cam.matrix.fromArray(pose.transform.matrix);
    cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
    return true;
  },

  /* Gamepads que expone la sesión (los controles del Quest). El mando
     Bluetooth del teléfono NO es un XRInputSource: ese sigue entrando por
     navigator.getGamepads(), y si dentro de la sesión dejara de aparecer, el
     reporte lo dice — es uno de los datos que vinimos a buscar. */
  _gamepadsXR() {
    const out = [];
    const s = this.session;
    if (!s || !s.inputSources) return out;
    for (const src of s.inputSources) if (src.gamepad) out.push(src.gamepad);
    return out;
  },

  /* --- Medición ---
     Dentro de la sesión el DOM no se ve, así que esto es lo único que va a
     quedar del rendimiento real. Se muestrea dos veces por segundo. */
  _medir(now) {
    const m = this._medidas;
    m.frames++;
    if (now - this._muestreo < 500) return;
    this._muestreo = now;

    if (Perf.fps > 0) {
      m.fpsSuma += Perf.fps; m.fpsN++;
      if (Perf.fps < m.fpsMin) m.fpsMin = Perf.fps;
    }
    if (Perf.p95 > m.p95Max) m.p95Max = Perf.p95;
    const r = this.renderer.info.render;
    m.tris = r.triangles; m.calls = r.calls;

    // Geometría real del visor: se lee una vez, cuando el runtime ya entregó
    // las dos vistas. Es el dato que decide si XR gana o no contra el
    // cardboard casero (557×501 por ojo, separación calibrada a mano).
    const camXR = this.renderer.xr.getCamera && this.renderer.xr.getCamera();
    if (camXR && camXR.cameras && camXR.cameras.length && m.ipd === null) {
      const c0 = camXR.cameras[0];
      if (c0.viewport) m.viewport = `${Math.round(c0.viewport.z)}×${Math.round(c0.viewport.w)}`;
      const p = c0.projectionMatrix.elements;
      if (p[5]) {
        m.fovY = 2 * Math.atan(1 / p[5]) * 180 / Math.PI;
        m.aspectOjo = p[0] ? p[5] / p[0] : null;
        this._ajustarVigneta(m.fovY, m.aspectOjo);
      }
      if (camXR.cameras.length === 2) {
        const a = camXR.cameras[0].matrixWorld.elements, b = camXR.cameras[1].matrixWorld.elements;
        m.ipd = Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);
      } else {
        m.ipd = 0;                            // una sola vista: no es estéreo
      }
    }
    /* Todo lo que se lee de la SESIÓN hay que copiarlo mientras está viva: el
       reporte se arma en el evento `end`, cuando `this.session` ya es null.
       (Se escapó en la primera pasada y el frameRate salía siempre vacío.) */
    const s = this.session;
    if (s) {
      const bl = s.renderState && s.renderState.baseLayer;
      if (bl && !m.framebuffer) m.framebuffer = `${bl.framebufferWidth}×${bl.framebufferHeight}`;
      m.frameRate = s.frameRate || null;
      m.frameRates = s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null;
      m.blend = s.environmentBlendMode || null;
      m.interaccion = s.interactionMode || null;
    }

    // Qué mandos se ven DESDE ADENTRO de la sesión, y si sus ejes se mueven.
    // Si el mando del dueño desaparece acá, XR no sirve para navegar todavía y
    // hay que saberlo con un dato, no por deducción.
    this._verMandos(navigator.getGamepads ? navigator.getGamepads() : [], "sistema");
    this._verMandos(this._gamepadsXR(), "sesión");
  },

  _verMandos(lista, fuente) {
    const m = this._medidas;
    for (const gp of lista) {
      if (!gp) continue;
      const k = `${gp.id} [${fuente}]`;
      const st = m.mandos[k] || (m.mandos[k] = { ejes: 0, botones: 0, movio: false, pulso: false });
      st.ejes = gp.axes ? gp.axes.length : 0;
      st.botones = gp.buttons ? gp.buttons.length : 0;
      if (gp.axes && gp.axes.some(v => Math.abs(v) > 0.4)) st.movio = true;
      if (gp.buttons && gp.buttons.some(b => b && b.pressed)) st.pulso = true;
    }
  },

  /* La viñeta se escala al cuadro con el fov de SOFTWARE, y en XR el fov lo
     pone el runtime (y es asimétrico por ojo). Se reajusta con el fov real
     apenas se conoce, y con un margen del 15 % porque el eje óptico de cada
     ojo está descentrado: mejor que sobre anillo a que se vea el borde. */
  _ajustarVigneta(fovY, aspect) {
    if (!fovY || this._fovVigneta === fovY) return;
    this._fovVigneta = fovY;
    Vigneta.ajustar({ fov: fovY * 1.15 }, aspect || 1);
  },

  /* Lo llama el evento `end` de la sesión (venga de donde venga) */
  _fin(motivo) {
    if (!this.session) return;
    this.session = null;
    const m = this._medidas;
    if (m) { m.fin = performance.now(); m.motivo = this._motivoFin || motivo || ""; }
    this._motivoFin = "";
    this.reporte = this.reporteTexto();
    console.log("[webxr] sesión terminada\n" + this.reporte);
    if (this.onSalir) this.onSalir(this.reporte);
  },

  /* --- Reporte ---
     Es el entregable de esta fase: el dueño no puede leer el HUD dentro de la
     sesión, así que todo lo medido se muestra al salir, en la pantalla del
     teléfono y en la consola. */
  datos() {
    const m = this._medidas;
    if (!m) return null;
    const seg = ((m.fin || performance.now()) - m.inicio) / 1000;
    return {
      refSpace: this.tipoRef,
      duracionS: +seg.toFixed(1),
      framesTotales: m.frames,
      fpsMedidoPorFrames: seg > 0 ? +(m.frames / seg).toFixed(1) : 0,
      fpsPromedioHUD: m.fpsN ? +(m.fpsSuma / m.fpsN).toFixed(1) : 0,
      fpsMinimo: m.fpsMin === Infinity ? 0 : +m.fpsMin.toFixed(1),
      p95PeorMs: +m.p95Max.toFixed(1),
      triangulosPorOjo: m.tris, drawCallsPorOjo: m.calls,
      framebuffer: m.framebuffer,
      viewportPorOjo: m.viewport,
      escalaFramebuffer: this._fbsPedido || "(default)",
      ipdRuntimeM: m.ipd == null ? null : +m.ipd.toFixed(4),
      fovVerticalPorOjo: m.fovY == null ? null : +m.fovY.toFixed(1),
      aspectPorOjo: m.aspectOjo == null ? null : +m.aspectOjo.toFixed(3),
      frameRate: m.frameRate || null,
      frameRatesSoportados: m.frameRates || null,
      environmentBlendMode: m.blend || null,
      interactionMode: m.interaccion || null,
      mandos: m.mandos,
      motivoFin: m.motivo,
      tier: Perf.tier, escalon: Perf.escalon
    };
  },

  reporteTexto() {
    const d = this.datos();
    if (!d) return "(sin datos: la sesión no llegó a arrancar)";
    const L = [];
    L.push(`reference space: ${d.refSpace} · duración ${d.duracionS} s · ${d.framesTotales} frames`);
    L.push(`fps ${d.fpsMedidoPorFrames} (por frames) · ${d.fpsPromedioHUD} (promedio) · mínimo ${d.fpsMinimo} · p95 peor ${d.p95PeorMs} ms`);
    L.push(`${(d.triangulosPorOjo / 1000).toFixed(0)} k triángulos · ${d.drawCallsPorOjo} draw calls (por ojo) · tier ${d.tier} escalón ${d.escalon}`);
    L.push(`framebuffer ${d.framebuffer || "?"} · viewport por ojo ${d.viewportPorOjo || "?"} · escala ${d.escalaFramebuffer}`);
    L.push(`IPD del runtime ${d.ipdRuntimeM == null ? "?" : d.ipdRuntimeM + " m"} · fov vertical ${d.fovVerticalPorOjo || "?"}° · aspect ${d.aspectPorOjo || "?"}`);
    L.push(`frameRate ${d.frameRate || "no lo reporta"}` +
      (d.frameRatesSoportados ? ` (soporta ${d.frameRatesSoportados.join(", ")})` : "") +
      ` · blend ${d.environmentBlendMode || "?"} · interacción ${d.interactionMode || "?"}`);
    const mandos = Object.keys(d.mandos);
    L.push(`mandos vistos dentro de la sesión: ${mandos.length ? "" : "NINGUNO"}`);
    for (const k of mandos) {
      const v = d.mandos[k];
      L.push(`  · ${k}: ${v.botones} botones, ${v.ejes} ejes` +
        ` · ejes ${v.movio ? "SE MOVIERON" : "quietos"} · botones ${v.pulso ? "pulsados" : "sin pulsar"}`);
    }
    if (d.motivoFin) L.push(`fin: ${d.motivoFin}`);
    return L.join("\n");
  },

  info() {
    return Object.assign({
      soportado: this.soporte,
      sesionAbierta: !!this.session,
      corriendo: this.corriendo
    }, this.datos() || {});
  }
};
