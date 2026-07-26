/* ============================================================
   tour-vr.js — Tour automático en VR (P6).

   Port de `startTour` / `buildTourWaypoints` / `flyAlongPath` del proyecto de
   origen (main.js:1036-1139) a movimiento del RIG. La ruta y el perfil de
   velocidad del vuelo rasante salen de `core-route.js`, que es copia verbatim
   y **no se toca**: fue calibrado en dos rondas hasta que el dueño lo aprobó
   como «resultado perfecto».

   Tres reglas que manda la arquitectura y que este archivo respeta:

   1. **Sin `requestAnimationFrame` propio.** El paso del tour lo avanza el
      driver de display desde su callback, igual que el cross-fade de escenario
      (novena ronda): un rAF del documento se congela dentro de una sesión de
      WebXR, y ahí el tour quedaría clavado en el primer waypoint.
   2. **Sólo se mueve el rig, y sólo en posición y yaw** (§9.11.2). La cabeza
      es del usuario: durante el tour puede mirar a donde quiera. Nunca se
      escribe pitch ni roll — «el bearing ya no es la mirada, es la dirección
      de avance» (§9.12).
   3. **Cualquier acción del usuario lo corta.** Es lo que hace el original con
      los eventos del canvas, y en VR importa más: si el mando no cancelara, el
      tour y el usuario se pelearían por el rig.

   Lo que NO se hereda del original, y por qué:
   - **La velocidad.** `makeFlight` vuela a 75 m/s de crucero, que desde una
     vista de mapa es cómodo y en un visor no. Acá el tiempo del vuelo se
     reproduce a `velCrucero / 75`, así que **el perfil relativo se conserva
     intacto** —incluidas las frenadas en las curvas, que es lo que hace que el
     paneo no sea un latigazo— pero la velocidad absoluta baja a algo del orden
     de lo que el dueño aprobó para el vuelo manual (14 m/s a 18 m).
   - **La duración.** El original comprime el corredor entero en 22 s como
     máximo, o sea que en un corredor largo ACELERA hasta pasar los 100 m/s.
     Acá es al revés: se vuela a velocidad cómoda durante un tiempo acotado y
     se recorre el tramo que entre. Mostrar 500 m de corredor bien es mejor
     demostración que cruzar 2,7 km a las apuradas.
   - **Las alturas.** Los waypoints del original son poses de MapLibre
     (zoom + pitch) y no se traducen a una altura: §9.12 explica por qué y
     manda elegirlas por criterio. Son los diales de acá abajo.

   Los TEXTOS de los mensajes se copian tal cual: son parte del guión
   comercial del proyecto.
   ============================================================ */
"use strict";

/* Crucero del `makeFlight` original, en m/s. No es un dial: es el valor con el
   que está construido el perfil de tiempos de core-route.js, y se usa para
   calcular a qué ritmo hay que reproducirlo. */
const CRUISE_ORIGINAL = 75;

const Tour = {
  activo: false,
  mensaje: "",
  ruta: [], paso: -1,

  /* --- Diales (§9.12: elegidos por criterio, para ajustar con el visor) --- */
  /* 14 m/s es EXACTAMENTE la velocidad de vuelo manual que el dueño aprobó a
     altura de dron (tabla "Configuración aprobada"). Usar la misma no es
     pereza: hace que el rasante del tour se sienta como lo que él ya validó,
     en vez de estrenar un número nuevo en el modo donde el usuario no tiene el
     control —que es el que peor se tolera—. §9.12 proponía 25–35 m/s, pero eso
     se escribió antes de que P5 calibrara la velocidad con él. */
  velCrucero: 14,          // m/s en el rasante · ?tourvel=<m/s>
  MAX_RASANTE_MS: 28000,   // techo del vuelo rasante
  ALT_GENERAL: 150,        // m — sobrevuelo del establecimiento
  ALT_APROX: 60,           // m — aproximación a un corredor
  ALT_PARCHE: 45,          // m — órbita sobre un parche leñoso
  RADIO_ORBITA: 130,       // m
  /* ALTURA DE LOS TRASLADOS. Un waypoint de pose recorre la distancia que sea
     en el tiempo que tenga, así que entre dos puntos lejanos la velocidad se
     dispara: medido, **891 m/s** en el salto al parche de monte. En un mapa
     eso es un `easeTo` cualquiera; en un visor es un borrón que marea.

     La cura no es ir más lento —el tour duraría cinco minutos— sino SUBIR: lo
     que marea es el flujo óptico, que va como v/h, así que un traslado rápido
     y alto es cómodo y uno rápido y bajo no.

     La altura de crucero del tramo se DESPEJA de ese criterio
     (`velocidad_pico / FLUJO_TRANSITO`), no de una fracción de la distancia:
     ese proxy se equivocaba justo en los ascensos —de 18 a 150 m la altura a
     mitad de tramo es 84 y no 150— y dejaba picos de 1,33 /s contra los 0,78
     de la configuración aprobada. */
  FLUJO_TRANSITO: 0.85,    // 1/s (la referencia aprobada es 0,78)
  /* Presupuesto de subir y bajar. Es más holgado que el horizontal por dos
     razones: subir mirando al frente barre menos imagen que trasladarse, y con
     el número horizontal cada tramo se iba a más de veinte segundos. El 2,0
     está calibrado contra lo que el dueño YA probó y le pareció «muy
     agradable»: los descensos de esa versión andaban por ahí, y lo único que
     objetó fue el rebote, que era la forma y no la velocidad. */
  FLUJO_VERTICAL: 2.0,     // 1/s — ver _msPorCambioDeAltura
  /* Altura a la que se QUIERE que crucen los traslados. Sin esto, un tramo de
     2,4 km en 8 s necesita 600 m para cumplir el flujo, y el tour se pasaba
     casi todo el tiempo tan arriba que no se ve la vegetación — que es el
     activo visual del proyecto. La altura no es la única variable: dándole
     TIEMPO al tramo baja la velocidad y con ella la altura necesaria. Un
     traslado largo pasa a durar ~14 s en vez de 8 y cruza a 300 m. */
  ALT_TRANSITO_OBJ: 300,   // m
  ALT_TRANSITO_MAX: 900,   // m — tope duro
  /* El arco sube ANTES de que el traslado agarre velocidad. Con un seno pelado
     el pico de flujo se daba al cuarto del tramo —ya rápido y todavía bajo— y
     medía 1,53 /s contra los 0,78 de referencia. Con el exponente, a un décimo
     del tramo ya está a media altura. */
  /* Fracción del tramo que se usa para subir a la meseta y para bajar de ella.
     La ventana es un smoothstep, no un seno elevado: con el seno la derivada
     en t=0 es infinita y el primer frame del tramo daba **1805 m/s de
     velocidad vertical** — un tirón hacia arriba que se siente como un golpe.
     El smoothstep arranca con derivada cero. */
  RAMPA_ARCO: 0.25,
  /* ANTIRREBOTE. Reporte del dueño con el visor puesto (2026-07-26): «desciende
     sobre un corredor y apenas toca el suelo vuelve a subir, parece que
     rebota». Tenía razón y era un defecto del diseño del arco: un tramo bajaba
     a 60 m y el siguiente, que era largo, tenía que subir a 200 para respetar
     el flujo óptico. Cada tramo por separado estaba bien; el problema era la
     costura entre dos.

     Dos correcciones, y ninguna toca el criterio de flujo:
     - el waypoint no baja por debajo de lo que el tramo SIGUIENTE va a
       necesitar subir (esta constante es la fracción que se respeta);
     - y dentro del tramo, la altura se SOSTIENE y baja al final en vez de
       hacer una loma: `max(interpolación, altura_necesaria)`. Es lo que hace
       un dron de verdad, y se lee como un solo movimiento.

     Vale 1 y no 0,7: con 0,7 quedaban lomas de unos 50 m —el 30 % que no se
     respetaba— y en el visor una loma de 50 m a esa altura todavía se ve. Con
     1 el descenso hacia el corredor es monótono de punta a punta. */
  ANTIRREBOTE: 1,
  /* Tope de giro AUTOMÁTICO. El usuario gira a 55 °/s y lo aprobó, pero ahí
     manda él; §9.11.3 marca la rotación que uno no controla como la causa
     número uno de mareo. Los rumbos de destino son al azar (como en el
     original), así que recortar cuánto se gira no cuesta nada. */
  GIRO_MAX: 15,            // °/s
  alturaRasante: null,     // null ⇒ la altura de dron del campo (18 m)
  RAMPA_MS: 1500,          // entrada y salida del rasante
  TAU_RUMBO: 350,          // ms — amortiguado del rumbo, del original
  vinetaFactor: 1,         // 1 = la misma viñeta que en vuelo manual

  onMensaje: null, onFin: null,

  /* `_ahora` es el reloj del DRIVER, no `performance.now()`. El tour no lee
     la hora por su cuenta en ningún lado: el tiempo se lo pasa quien lo
     avanza. Así el mismo código sirve para el rAF del documento, para el de
     una sesión de WebXR y para una prueba con reloj sintético. */
  _wp: null, _t0: 0, _tau: 0, _bear: 0, _desde: null, _prev: null, _ahora: 0,

  init({ onMensaje, onFin } = {}) {
    this.onMensaje = onMensaje; this.onFin = onFin;
    if (params.has("tourvel")) this.velCrucero = Math.max(3, +params.get("tourvel") || this.velCrucero);
    if (params.has("touralt")) this.alturaRasante = Math.max(2, +params.get("touralt") || 0) || null;
    // ?tourvin=0..1 — por default la viñeta del tour es la misma que la del
    // vuelo manual aprobado; el dial existe para poder aflojarla en el visor si
    // 80 segundos seguidos de periferia oscurecida molestan en la demostración
    if (params.has("tourvin")) this.vinetaFactor = Math.max(0, Math.min(1, +params.get("tourvin")));
    return this;
  },

  /* --- Control --- */
  alternar(fc, extent) { this.activo ? this.detener("el usuario") : this.arrancar(fc, extent); },

  arrancar(fc, extent, ahora) {
    const ruta = this._armarRuta(fc, extent);
    if (!ruta.length) { console.warn("tour: no hay waypoints para este campo"); return false; }
    this.ruta = ruta; this.paso = -1; this.activo = true;
    this._ahora = ahora != null ? ahora : performance.now();
    this._prev = { x: Rig.rig.position.x, z: Rig.rig.position.z, alt: Rig.alturaOjo() };
    this._siguiente();
    return true;
  },

  detener(motivo) {
    if (!this.activo) return;
    this.activo = false; this._wp = null;
    Rig.flujoTour = 0;
    this._anunciar("");
    if (this.onFin) this.onFin(motivo);
  },

  _anunciar(txt) {
    this.mensaje = txt;
    if (this.onMensaje) this.onMensaje(txt);
  },

  /* --- Avance, una vez por frame, desde el driver --- */
  update(dtMs, now) {
    if (!this.activo || !this._wp) return;
    this._ahora = now;

    /* Tomar el control cancela el tour. Va acá y no en el orquestador porque
       es responsabilidad del tour: si no cancelara, la locomoción del usuario
       y el tour se pisarían el rig en el mismo frame. El intent ya está leído
       para este frame (lo lee el driver antes de llamar acá). */
    const i = typeof Input !== "undefined" && Input.intent;
    if (i && Math.abs(i.move.x) + Math.abs(i.move.y) + Math.abs(i.turn) + Math.abs(i.rise) > 0.05) {
      this.detener("el usuario tomó el control");
      return;
    }

    const wp = this._wp;
    const dur = wp.msReal || wp.ms;              // los traslados se alargan si el giro lo pide
    const t = dur > 0 ? Math.min(1, (now - this._t0) / dur) : 1;

    if (wp.tipo === "vuelo") this._pasoVuelo(wp, dtMs, now);
    else if (wp.tipo === "orbita") this._pasoOrbita(wp, t);
    else this._pasoPose(wp, t);

    /* Viñeta por FLUJO ÓPTICO (§9.11.5), que es v/h y no los m/s: es la misma
       decisión que se tomó para el vuelo manual en la cuarta ronda. La
       referencia es el flujo de la configuración aprobada —14 m/s a 18 m, o
       sea 0,78 /s—, así que el tour se siente como lo que el dueño ya validó
       y no hace falta inventar un criterio nuevo. */
    const p = Rig.rig.position;
    const alt = Rig.alturaOjo();
    /* La velocidad va en 3D: el ascenso también genera flujo, y no poco —
       subir 280 m en dos segundos desde 18 m de altura barre la imagen tanto
       o más que cruzar el campo. Medirlo sólo en horizontal escondía
       justamente los tirones verticales del arranque de cada tramo. */
    const v = this._prev
      ? Math.hypot(p.x - this._prev.x, p.z - this._prev.z, alt - this._prev.alt) / Math.max(dtMs / 1000, 1e-4)
      : 0;
    this._prev = { x: p.x, z: p.z, alt };
    this.flujoOptico = v / Math.max(alt, 2);
    const FLUJO_REF = Rig.vel.dron / Rig.ALT_REF;
    Rig.flujoTour = Math.min(1, this.flujoOptico / FLUJO_REF) * this.vinetaFactor;

    if (wp.tipo !== "vuelo" && t >= 1) this._siguiente();
  },

  _siguiente() {
    this.paso++;
    if (this.paso >= this.ruta.length) { this.detener("terminó"); return; }
    const wp = this.ruta[this.paso];
    this._wp = wp; this._t0 = this._ahora; this._tau = 0;
    // pose de partida del tramo: la interpolación va de acá al destino
    this._desde = { x: Rig.rig.position.x, z: Rig.rig.position.z, alt: Rig.alturaOjo(), rumbo: Rig.rumbo() };
    /* El rasante arranca con el rumbo que TIENE el rig, no con el de la ruta:
       el amortiguado lo lleva al del corredor en ~350 ms. Poniendo el de la
       ruta de una, cualquier diferencia que dejara la aproximación —y ahora
       queda alguna, porque el giro de los traslados está topeado— se vería
       como un latigazo justo al empezar el tramo más lindo. */
    if (wp.tipo === "vuelo") this._bear = Rig.rumbo();
    /* El arco depende de cuán lejos quedó el punto de partida, así que se
       calcula recién acá y no al armar la ruta. Se anula en el destino
       (sin(π) = 0), o sea que el tramo TERMINA en la pose exacta: es lo que
       permite que la aproximación empalme con el rasante sin salto. */
    if (wp.tipo === "pose") {
      const d = this._desde;
      const delta = ((wp.rumbo - d.rumbo) % 360 + 540) % 360 - 180;
      wp.delta = delta;
      /* El tramo dura lo que pida el giro. Antes se recortaba el giro para
         respetar GIRO_MAX, y eso dejaba al rig llegando desalineado al
         rasante: el amortiguado del vuelo tenía que corregir 100° o más y
         medía **294 °/s** de latigazo, justo al empezar el tramo más lindo.
         Alargar el tramo cuesta unos segundos de tour y llega apuntando bien.
         El easing pica en 1,5 × Δ/T, de ahí el factor. */
      const D = Math.hypot(wp.x - d.x, wp.z - d.z);
      const msBase = Math.max(wp.ms, 1500 * Math.abs(delta) / this.GIRO_MAX, this._msPorDistancia(D));
      const hC = Math.min(this.ALT_TRANSITO_MAX, (1.5 * D / (msBase / 1000)) / this.FLUJO_TRANSITO);
      // …y el tramo también tiene que durar lo suficiente para SUBIR hasta la
      // meseta sin pasarse del flujo (ver el comentario de _msPorAscenso)
      wp.msReal = Math.max(msBase,
        this._msPorCambioDeAltura(d.alt, hC), this._msPorCambioDeAltura(wp.alt, hC));
      const vPico = 1.5 * D / (wp.msReal / 1000);
      wp.hCrucero = Math.min(this.ALT_TRANSITO_MAX, vPico / this.FLUJO_TRANSITO);
    }
    this._anunciar(wp.msg || "");
    // el rig se movió de golpe entre tramos lejanos: que el culling no espere
    // los 200 ms de la próxima revisión
    if (typeof Chunks !== "undefined") Chunks.invalidar();
  },

  /* Interpolación de pose. `t*t*(3-2*t)` es el mismo easing del original
     (arranca y frena en velocidad cero). El rumbo va por el camino corto. */
  _pasoPose(wp, t) {
    const s = t * t * (3 - 2 * t);
    const d = this._desde;
    Rig.setPosicion(d.x + (wp.x - d.x) * s, d.z + (wp.z - d.z) * s);
    /* Altura: la interpolación, pero SOSTENIDA en la altura de crucero
       mientras el tramo va rápido. Con `max` el perfil sube al principio si
       hace falta, se mantiene, y baja recién al final — un solo movimiento de
       dron. Antes era una suma (una loma) y eso, encadenado con el tramo
       anterior, era el "rebote" que reportó el dueño. La ventana vale 0 en
       t=1, así que el tramo TERMINA en la altura exacta del waypoint: es lo
       que permite que la aproximación empalme con el rasante. */
    /* La altura se interpola EN LOGARITMO, no en metros. Bajar de 300 a 18 m
       en línea recta significa acercarse al suelo a velocidad constante, y el
       flujo óptico —que es v/h— se dispara justo al final: medido, 3,3 /s
       contra los 0,78 de referencia. En logaritmo la velocidad vertical baja
       con la altura, que es como desciende un dron de verdad, y el flujo queda
       CONSTANTE durante todo el descenso.

       Tres tramos: subir a la meseta en la rampa de entrada, cruzar, y bajar
       en la de salida. En t=0 y en t=1 da exactamente las alturas pedidas. */
    const r = this.RAMPA_ARCO;
    const suave = x => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
    const entrada = suave(t / r), salida = suave((t - (1 - r)) / r);
    const lnA = Math.log(Math.max(d.alt, 2)), lnB = Math.log(Math.max(wp.alt, 2));
    const lnC = Math.log(Math.max(wp.hCrucero || 0, Math.max(d.alt, wp.alt), 2));
    const ln = lnA * (1 - entrada) + lnC * (entrada - salida) + lnB * salida;
    Rig.setAlturaOjo(Math.exp(ln));
    Rig.setRumbo(d.rumbo + (wp.delta || 0) * s);
  },

  /* Órbita alrededor de un punto, mirando hacia él. Es el port del waypoint
     de `bearing + 140` del original, que en MapLibre gira la cámara alrededor
     del centro. Acá el rig recorre el arco y el rumbo apunta al centro: la
     tasa de giro queda en ~15 °/s, muy por debajo de los 55 °/s del giro
     manual, que es el límite de lo cómodo que fijó P5. */
  _pasoOrbita(wp, t) {
    const s = t * t * (3 - 2 * t);
    const ang = (wp.ang0 + wp.giro * s) * Math.PI / 180;
    // ang es la posición angular alrededor del centro, medida como rumbo
    Rig.setPosicion(wp.cx + Math.sin(ang) * wp.radio, wp.cz - Math.cos(ang) * wp.radio);
    Rig.setAlturaOjo(this._desde.alt + (wp.alt - this._desde.alt) * s);
    // mirar al centro = rumbo opuesto a la posición angular
    Rig.setRumbo(wp.ang0 + wp.giro * s + 180);
  },

  /* Vuelo rasante. Port de flyAlongPath (main.js:1039-1055) con dos cambios
     documentados arriba: el ritmo de reproducción baja la velocidad absoluta
     sin tocar el perfil, y el tramo lo corta el tiempo, no al revés. */
  _pasoVuelo(wp, dtMs, now) {
    const transcurrido = now - this._t0;
    const restante = wp.ms - transcurrido;
    // rampa de entrada y de salida, por TIEMPO (§12.2)
    const rampa = Math.min(1, transcurrido / this.RAMPA_MS, Math.max(0, restante) / this.RAMPA_MS);
    const k = this.velCrucero / CRUISE_ORIGINAL;
    this._tau += (dtMs / 1000) * k * rampa;

    const d = wp.flight.distAtTime(this._tau);
    const [lon, lat] = wp.flight.at(d);
    const [x, z] = lonLatToScene(lon, lat);
    Rig.setPosicion(x, z);
    Rig.setAlturaOjo(this.alturaRasante || Rig.alturaDron);

    /* Amortiguado del rumbo del original, con un tope de tasa: la fórmula sola
       corrige un error grande a cientos de °/s, que es exactamente el latigazo
       que se midió antes de alargar las aproximaciones. Con la aproximación
       llegando alineada el tope no llega a actuar casi nunca; está para que un
       caso raro no arruine el tramo. */
    const delta = ((wp.flight.bearingAt(d) - this._bear) % 360 + 540) % 360 - 180;
    const paso = delta * (1 - Math.exp(-dtMs / this.TAU_RUMBO));
    const tope = this.GIRO_MAX * dtMs / 1000;
    this._bear += Math.sign(paso) * Math.min(Math.abs(paso), tope);
    Rig.setRumbo(this._bear);

    if (this._tau >= wp.flight.timeTotal || restante <= 0) this._siguiente();
  },

  /* --- Armado de la ruta (port de buildTourWaypoints, main.js:1057-1103) ---
     Las clases y los criterios de selección son los del original; lo que
     cambia es que el destino de cada waypoint es una pose del rig. El azar se
     mantiene a propósito: hace que dos vuelos seguidos no sean idénticos. */
  _armarRuta(fc, extent) {
    const mezclar = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
    const rnd = (a, b) => a + Math.random() * (b - a);
    const porArea = cls => fc.features
      .filter(f => f.properties._cls === cls && f.geometry && f.geometry.coordinates.length)
      .sort((a, b) => (b.properties._sup || 0) - (a.properties._sup || 0));
    const escena = f => { const [lon, lat] = featureCentroid(f); return lonLatToScene(lon, lat); };

    const corredores = mezclar(porArea("corr-herb").concat(porArea("corr-le")).slice(0, 6)).slice(0, 2);
    const parches = mezclar(porArea("parche-le").slice(0, 5)).slice(0, 2);
    const cx = (extent.minX + extent.maxX) / 2, cz = (extent.minZ + extent.maxZ) / 2;

    /* Corredor del rasante: el herbáceo con el eje más largo, al azar entre
       los dos mejores para que el vuelo varíe. corridorCenterline devuelve
       null si el eje mide menos de 300 m. */
    const volables = porArea("corr-herb")
      .map(f => ({ f, cl: corridorCenterline(f) }))
      .filter(x => x.cl)
      .sort((a, b) => b.cl.lenM - a.cl.lenM);
    const razante = volables.length ? mezclar(volables.slice(0, 2))[0].cl : null;

    const wp = [];
    wp.push({ tipo: "pose", x: cx, z: cz, alt: this.ALT_GENERAL, rumbo: rnd(-40, 40), ms: 6000,
              msg: "Sobrevolando el establecimiento" });
    if (corredores[0]) {
      const [x, z] = escena(corredores[0]);
      wp.push({ tipo: "pose", x, z, alt: this.ALT_APROX, rumbo: rnd(0, 360), ms: 8000,
                msg: "Descendiendo sobre un corredor biológico" });
    }
    if (razante) {
      // arrancar por la punta más cercana al waypoint anterior, como el original
      const prev = wp[wp.length - 1];
      const p = razante.path;
      const dist2 = q => { const [qx, qz] = lonLatToScene(q[0], q[1]); return (qx - prev.x) ** 2 + (qz - prev.z) ** 2; };
      if (dist2(p[p.length - 1]) < dist2(p[0])) p.reverse();
      const flight = makeFlight(p);
      const [lon, lat] = flight.at(0);
      const [x, z] = lonLatToScene(lon, lat);
      /* La aproximación termina EXACTAMENTE en la pose donde arranca el
         rasante (posición, altura y rumbo): así la transición no tiene salto,
         que es la razón por la que el original repite la pose acá. */
      wp.push({ tipo: "pose", x, z, alt: this.alturaRasante || Rig.alturaDron,
                rumbo: flight.bearingAt(0), ms: 7000, msg: "Descendiendo al corredor" });
      wp.push({ tipo: "vuelo", flight, ms: this.MAX_RASANTE_MS,
                msg: "Vuelo rasante siguiendo el corredor" });
    } else if (corredores[1]) {
      const [x, z] = escena(corredores[1]);
      wp.push({ tipo: "pose", x, z, alt: this.ALT_APROX * 0.7, rumbo: rnd(0, 360), ms: 9000,
                msg: "Vuelo rasante sobre el corredor" });
    }
    if (parches[0]) {
      const [x, z] = escena(parches[0]);
      const ang0 = rnd(0, 360);
      // la aproximación deja el rig sobre el arco de la órbita, mirando al parche
      wp.push({ tipo: "pose",
                x: x + Math.sin(ang0 * Math.PI / 180) * this.RADIO_ORBITA,
                z: z - Math.cos(ang0 * Math.PI / 180) * this.RADIO_ORBITA,
                alt: this.ALT_PARCHE, rumbo: ang0 + 180, ms: 8000,
                msg: "Aproximación al parche de monte" });
      /* La órbita del original gira 140° en 9 s. Acá va MÁS LENTA (120° en 12)
         porque es rotación automática, que §9.11.3 señala como la causa número
         uno de mareo: 15 °/s de pico contra los 23 que daba el original
         portado tal cual, y muy por debajo de los 55 °/s del giro manual, que
         el usuario sí controla. */
      wp.push({ tipo: "orbita", cx: x, cz: z, radio: this.RADIO_ORBITA, alt: this.ALT_PARCHE,
                ang0, giro: 120, ms: 12000, msg: "Órbita sobre el parche leñoso" });
    }
    if (parches[1]) {
      const [x, z] = escena(parches[1]);
      wp.push({ tipo: "pose", x, z, alt: this.ALT_APROX, rumbo: rnd(0, 360), ms: 8000,
                msg: "Cruzando hacia otro parche de naturaleza" });
    }
    wp.push({ tipo: "pose", x: cx, z: cz, alt: this.ALT_GENERAL, rumbo: rnd(-30, 30), ms: 8000,
              msg: "Vista general del paisaje rediseñado" });
    this._antirrebote(wp);
    return wp;
  },

  /* Segunda mitad del antirrebote: se estima con las posiciones planificadas
     cuánta altura va a necesitar CADA tramo, y se levanta la llegada del
     anterior para que no baje a un lugar del que tiene que salir subiendo.

     El tramo que precede al rasante queda intacto a propósito: el siguiente es
     el vuelo, que no necesita altura, así que ahí el descenso a 18 m es el que
     corresponde y es el que se quiere ver. */
  /* Cuánto tiene que durar un traslado de D metros para cruzar a la altura
     objetivo sin pasarse del flujo. El 1,5 es el pico del easing. */
  _msPorDistancia(D) {
    return 1500 * D / (this.FLUJO_TRANSITO * this.ALT_TRANSITO_OBJ);
  },

  /* Cuánto tiene que durar el tramo para que el cambio de altura tampoco se
     pase del flujo. Con la altura en logaritmo el flujo vertical es
     |Δln h| / tiempo_de_rampa, así que despejar el tiempo es directo.

     El presupuesto vertical es más holgado que el horizontal a propósito:
     subir y bajar mirando al frente barre mucho menos la imagen que trasladarse,
     y con el mismo número los tramos se irían a más de veinte segundos cada
     uno. Es un dial: si en el visor las subidas molestan, se baja. */
  _msPorCambioDeAltura(altDesde, hMeseta) {
    const dln = Math.abs(Math.log(Math.max(hMeseta, 2)) - Math.log(Math.max(altDesde, 2)));
    return 1500 * dln / (this.RAMPA_ARCO * this.FLUJO_VERTICAL);
  },

  _antirrebote(wp) {
    let prev = { x: Rig.rig.position.x, z: Rig.rig.position.z };
    /* La estimación usa la MISMA fórmula que el tramo real (duración incluida),
       o el número no sirve: con `ms` a secas daba 608 m donde el tramo después
       volaba a 516, y esos 90 m de diferencia son otra loma. Lo que no se
       puede prever acá es cuánto va a girar —depende del rumbo que tenga el
       rig al llegar—, y eso sólo ALARGA el tramo, o sea que baja la altura
       necesaria: la estimación queda del lado seguro. */
    const necesita = wp.map(w => {
      if (w.tipo !== "pose") return 0;
      const D = Math.hypot(w.x - prev.x, w.z - prev.z);
      prev = { x: w.x, z: w.z };
      const ms = Math.max(w.ms, this._msPorDistancia(D));
      return Math.min(this.ALT_TRANSITO_MAX, (1.5 * D / (ms / 1000)) / this.FLUJO_TRANSITO);
    });
    for (let i = 0; i < wp.length - 1; i++) {
      if (wp[i].tipo !== "pose") continue;
      /* No basta con mirar el CRUCERO del tramo siguiente: también hay que
         mirar **dónde termina**. El último tramo bajaba a 62 m y el siguiente
         subía a los 150 de la vista general — 87 m de rebote medidos, y el
         mismo defecto que reportó el dueño, sólo que al final del recorrido.
         Sólo levanta: si lo que viene es más bajo (el descenso al corredor),
         esto no toca nada. */
      const sig = wp[i + 1];
      const altSig = sig.tipo === "vuelo" ? 0 : (sig.alt || 0);
      wp[i].alt = Math.max(wp[i].alt, necesita[i + 1] * this.ANTIRREBOTE, altSig);
    }
  },

  info() {
    return {
      activo: this.activo,
      paso: this.paso, de: this.ruta.length,
      tramo: this._wp ? this._wp.tipo : null,
      mensaje: this.mensaje,
      velCrucero: this.velCrucero,
      alturaRasante: this.alturaRasante || (typeof Rig !== "undefined" ? Rig.alturaDron : null),
      tau: +this._tau.toFixed(2)
    };
  }
};
