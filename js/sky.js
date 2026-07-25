/* ============================================================
   sky.js — Cielo, niebla y horizonte (§9.6).

   El original delega el cielo a MapLibre (main.js:342-349); acá se
   reponen esos tres colores exactos:
     sky-color #87b9e0 · horizon-color #dfe9d8 · fog-color #e6ecdc

   Tres piezas:
   1. Domo: esfera BackSide con gradiente cenit→horizonte. No se usa
      THREE.Sky (vive en examples/, no está en el bundle vendorizado).
   2. Niebla lineal (más controlable que FogExp2 para esconder el borde
      de la cobertura de tiles).
   3. Disco de relleno opaco del color de la niebla debajo de todo, para
      que nunca se vea el vacío si se mira hacia abajo en el borde.

   La niebla se ABRE con la altura: existe para tapar el borde del mundo
   cuando estás dentro de la escena; con valores fijos, desde una vista
   aérea taparía el campo entero. A altura de dron (≈18 m) da los valores
   de §9.6 (600 → 3500).
   ============================================================ */
"use strict";

const SKY_ZENIT = 0x87b9e0;
const SKY_HORIZONTE = 0xdfe9d8;
const SKY_NIEBLA = 0xe6ecdc;

const DOMO_R = 4800;        // < far de la cámara (6000)
const NIEBLA_FAR_MAX = 4200; // < radio del domo: todo lo lejano cierra en niebla

const Sky = {
  domo: null,
  piso: null,
  scene: null,

  init(scene) {
    this.scene = scene;
    scene.fog = new THREE.Fog(SKY_NIEBLA, 600, 3500);

    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,                       // el domo ES el fondo: no se nebliza
      uniforms: {
        cenit: { value: new THREE.Color(SKY_ZENIT) },
        horizonte: { value: new THREE.Color(SKY_HORIZONTE) },
        niebla: { value: new THREE.Color(SKY_NIEBLA) }
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 cenit, horizonte, niebla;
        varying vec3 vPos;
        void main() {
          float h = normalize(vPos).y;
          // el horizonte se estira hasta ~3/4 del domo, como el
          // sky-horizon-blend 0.6 de MapLibre
          vec3 c = mix(horizonte, cenit, smoothstep(0.0, 0.75, h));
          // justo sobre el horizonte arranca en el color de NIEBLA, no en el
          // de horizonte: si no, queda una costura visible contra el suelo
          // lejano, que a esa distancia ya es niebla pura
          c = mix(niebla, c, smoothstep(0.0, 0.13, h));
          gl_FragColor = vec4(mix(c, niebla, clamp(-h * 6.0, 0.0, 1.0)), 1.0);
        }`
    });
    this.domo = new THREE.Mesh(new THREE.SphereGeometry(DOMO_R, 32, 16), mat);
    this.domo.renderOrder = -100;
    this.domo.frustumCulled = false;
    scene.add(this.domo);

    // Relleno bajo todo: mismo color que la niebla, así el borde de los
    // tiles se disuelve en vez de cortar contra el vacío
    // depthTest/depthWrite en false: a 4 km la resolución del depth buffer
    // (near 0,1 / far 6000) es de ~15 m, así que medio metro de separación
    // contra el satélite NO alcanza y salían franjas de z-fighting en el
    // horizonte. Como el relleno es puro fondo, se dibuja antes que todo
    // (renderOrder -50) y el satélite lo tapa por orden, no por profundidad.
    this.piso = new THREE.Mesh(
      new THREE.CircleGeometry(DOMO_R, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: SKY_NIEBLA, fog: true, depthTest: false, depthWrite: false })
    );
    this.piso.position.y = -0.5;
    this.piso.renderOrder = -50;
    scene.add(this.piso);
    return this;
  },

  /* El domo y el relleno acompañan al observador en XZ (nunca se llega al
     borde) y la niebla se abre con la altura. */
  update(rig) {
    const x = rig.rig.position.x, z = rig.rig.position.z, alt = rig.alturaOjo();
    this.domo.position.set(x, 0, z);
    this.piso.position.set(x, -0.5, z);
    // A altura de dron (≈18 m) esto da ≈640 → 3590, los valores de §9.6.
    // Desde arriba se abre para no tapar el campo, pero el `far` nunca pasa
    // del radio del domo: el borde de la cobertura de tiles siempre cierra
    // en niebla. La banda de haze queda comprimida al último tramo.
    const fog = this.scene.fog;
    fog.near = Math.min(600 + alt * 2.4, NIEBLA_FAR_MAX - 900);
    fog.far = Math.min(3500 + alt * 5, NIEBLA_FAR_MAX);
  }
};
