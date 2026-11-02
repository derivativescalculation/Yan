import * as THREE from "three";

// One WebGL canvas, three scenes drawn into their columns with the scissor test.
// Pot index → vessel: 0 celadon jar 青罐, 1 copper-red vase 朱瓶, 2 square bronze cauldron 金鼎.

export interface VesselScene {
  /** fill level, 0..1 */
  setLevel(pot: number, lvl: number): void;
  dropCoins(pot: number, n: number): void;
  /** the opening vessel; the others dim. null restores all three */
  setActive(pot: number | null): void;
  setShake(pot: number, on: boolean): void;
  surge(pot: number, k: number): void;
  /** light beam over the cauldron */
  beam(on: boolean): void;
  /** px from the bottom of the pot's view to its mouth */
  mouthOffset(pot: number): number;
  dispose(): void;
}

export interface SceneOptions {
  reduce: boolean;
  onCoin?: () => void;
  /** false when the GL context is lost, true when it comes back */
  onGl?: (ok: boolean) => void;
}

const KINDS = ["jade", "cin", "gold"] as const;
type Kind = (typeof KINDS)[number];
const FLARE: Record<Kind, string> = { jade: "#9fd1b8", cin: "#ff7a5c", gold: "#f0c96a" };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Shared {
  renderer: THREE.WebGLRenderer;
  aniso: number;
  time: { value: number };
  decors: THREE.CanvasTexture[];
  repaints: (() => void)[];
  env: THREE.Texture;
  coinGeo: THREE.BufferGeometry;
  coinMat: THREE.MeshStandardMaterial;
  flareTex: THREE.Texture;
  lightTex: THREE.Texture;
  shadowTex: THREE.Texture;
}

interface Coin {
  on: boolean;
  x: number;
  y: number;
  z: number;
  vy: number;
  rx: number;
  ry: number;
  vr: number;
}

interface Vessel {
  kind: Kind;
  view: HTMLElement;
  scene: THREE.Scene;
  cam: THREE.PerspectiveCamera;
  group: THREE.Group;
  body: THREE.Group;
  u: { fill: { value: number }; glow: { value: THREE.Color } };
  lights: THREE.Light[];
  lightBase: number[];
  mats: THREE.MeshStandardMaterial[];
  lvl: number;
  dim: number;
  dimT: number;
  surge: number;
  surgeT: number;
  shake: number;
  beamA: number;
  beamT: number;
  flash: number;
  coins: Coin[];
  active: boolean;
  fillOffset: number;
  baseR: number;
  size: { h: number; w: number };
  fillMin: number;
  fillMax: number;
  mouthY: number;
  mouthR: number;
  elev: number;
  frac: number;
  coinScale: number;
  flareSize: number;
  spin: number;
  glowCol: THREE.Color;
  glowK: number;
  landY: () => number;
  standH: number;
  footprint: [number, number];
  topY: number;
  mouthB: number;
  light?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  beam?: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  spill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  inst: THREE.InstancedMesh;
  flare: THREE.Sprite;
}

/* ---------- shared textures and geometry ---------- */

function envScene() {
  const s = new THREE.Scene();
  s.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(20, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader:
          "varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 top = vec3(.02,.018,.016); vec3 mid = vec3(.07,.05,.035); vec3 bot = vec3(.14,.04,.02); gl_FragColor = vec4(h > 0. ? mix(mid, top, h) : mix(mid, bot, -h), 1.); }",
      }),
    ),
  );
  const box = (w: number, h: number, hex: string, k: number, pos: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  box(10, 6, "#ffe0b0", 3.4, [-7, 9, 6]);
  box(2.4, 12, "#dfe8ff", 1.8, [9, 2, -1]);
  box(14, 2.2, "#ffd59a", 1.1, [0, 2.5, 10]);
  box(16, 16, "#6a1a0c", 0.9, [0, -9, 0]);
  return s;
}

function coinGeometry() {
  const sh = new THREE.Shape();
  sh.absarc(0, 0, 0.07, 0, Math.PI * 2, false);
  const h = new THREE.Path();
  h.moveTo(-0.024, -0.024);
  h.lineTo(0.024, -0.024);
  h.lineTo(0.024, 0.024);
  h.lineTo(-0.024, 0.024);
  h.lineTo(-0.024, -0.024);
  sh.holes.push(h);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 24 });
  g.center();
  return g;
}

function radial(size: number, stops: [number, string][]) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
const flareTexture = () => radial(128, [[0, "rgba(255,250,235,.9)"], [0.18, "rgba(255,230,180,.35)"], [1, "rgba(255,200,120,0)"]]);
const shadowTexture = () => radial(128, [[0, "rgba(0,0,0,.8)"], [0.5, "rgba(0,0,0,.42)"], [1, "rgba(0,0,0,0)"]]);

function lightTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(256, 256, 8, 256, 256, 330);
  g.addColorStop(0, "#fff8e2");
  g.addColorStop(0.35, "#ffd77a");
  g.addColorStop(0.75, "#d99a34");
  g.addColorStop(1, "#8a5718");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  x.globalAlpha = 0.12;
  x.strokeStyle = "#fff";
  x.lineWidth = 3;
  for (let r = 40; r < 360; r += 34) {
    x.beginPath();
    x.arc(256, 256, r, 0, Math.PI * 2);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uC: { value: new THREE.Color("#ffd27a") } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader:
      "varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader:
      "uniform float uA; uniform vec3 uC; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float face = pow(abs(dot(normalize(vN), normalize(vV))), 2.2); float a = pow(1.0 - vUv.y, 2.0) * uA * face * (0.7 + 0.3 * sin(vUv.x * 6.2831 * 9.0)); gl_FragColor = vec4(uC * 1.8, a * 0.85); }",
  });
}

/* ---------- decoration painted into a canvas: a mask for the patina colour and the inner glow ---------- */

type Ctx = CanvasRenderingContext2D;

function decorTexture(G: Shared, H: number, draw: (x: Ctx, W: number, y: (h: number) => number) => void) {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 1024;
  const x = c.getContext("2d")!;
  const y = (h: number) => (1 - h / H) * c.height;
  const paint = () => {
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = x.strokeStyle = "#fff";
    x.lineCap = x.lineJoin = "round";
    x.globalAlpha = 1;
    draw(x, c.width, y);
  };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = G.aniso;
  t.wrapS = THREE.RepeatWrapping;
  G.decors.push(t);
  G.repaints.push(() => {
    paint();
    t.needsUpdate = true;
  });
  return t;
}

function ring(x: Ctx, W: number, y: number, w: number) {
  x.fillRect(0, y - w / 2, W, w);
}

function meanderSpan(x: Ctx, xa: number, xb: number, y0: number, y1: number) {
  const h = y1 - y0;
  const n = Math.max(1, Math.round((xb - xa) / (h * 1.5)));
  const s = (xb - xa) / n;
  x.lineWidth = Math.max(2.5, h * 0.09);
  x.beginPath();
  for (let i = 0; i < n; i++) {
    const P = (a: number, b: number): [number, number] => [xa + i * s + a * s, y0 + b * h];
    [[0, 0.9], [0.14, 0.9], [0.14, 0.12], [0.86, 0.12], [0.86, 0.72], [0.38, 0.72], [0.38, 0.4], [0.62, 0.4]].forEach(([a, b], j) => {
      const [px, py] = P(a, b);
      if (j) x.lineTo(px, py);
      else x.moveTo(px, py);
    });
    x.moveTo(...P(0.86, 0.9));
    x.lineTo(...P(1, 0.9));
  }
  x.stroke();
  x.fillRect(xa, y0 - h * 0.12 - 1.5, xb - xa, 3);
  x.fillRect(xa, y1 + h * 0.08 - 1.5, xb - xa, 3);
}

function meander(x: Ctx, W: number, y0: number, y1: number) {
  meanderSpan(x, 0, W, y0, y1);
}

function lotus(x: Ctx, W: number, top: number, bottom: number, n: number) {
  const s = W / n;
  const h = bottom - top;
  x.lineWidth = 5;
  for (let i = 0; i < n; i++) {
    const x0 = i * s + s * 0.06;
    const x1 = (i + 1) * s - s * 0.06;
    const xm = (x0 + x1) / 2;
    x.beginPath();
    x.moveTo(x0, bottom);
    x.quadraticCurveTo(x0, top + h * 0.22, xm, top);
    x.quadraticCurveTo(x1, top + h * 0.22, x1, bottom);
    x.stroke();
    x.beginPath();
    x.moveTo(x0 + s * 0.16, bottom);
    x.quadraticCurveTo(x0 + s * 0.16, top + h * 0.5, xm, top + h * 0.3);
    x.quadraticCurveTo(x1 - s * 0.16, top + h * 0.5, x1 - s * 0.16, bottom);
    x.stroke();
  }
  ring(x, W, bottom, 4);
}

function ruyi(x: Ctx, W: number, top: number, bottom: number, n: number) {
  const s = W / n;
  const h = bottom - top;
  x.lineWidth = 5;
  for (let i = 0; i < n; i++) {
    const xm = i * s + s / 2;
    x.beginPath();
    x.moveTo(xm - s * 0.44, top);
    x.bezierCurveTo(xm - s * 0.52, top + h * 0.75, xm - s * 0.12, top + h * 0.5, xm, bottom);
    x.bezierCurveTo(xm + s * 0.12, top + h * 0.5, xm + s * 0.52, top + h * 0.75, xm + s * 0.44, top);
    x.stroke();
    x.beginPath();
    x.arc(xm - s * 0.2, top + h * 0.36, s * 0.07, 0, Math.PI * 1.6);
    x.stroke();
    x.beginPath();
    x.arc(xm + s * 0.2, top + h * 0.36, s * 0.07, Math.PI * 1.4, Math.PI * 3);
    x.stroke();
  }
  ring(x, W, top, 4);
}

function leiwen(x: Ctx, cx: number, cy: number, r: number) {
  x.beginPath();
  [[0, 0], [0.5, 0], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5], [1, -0.5], [1, 1], [-1, 1]].forEach(([a, b], i) => {
    const px = cx + a * r;
    const py = cy + b * r;
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  });
  x.stroke();
}

function stud(x: Ctx, cx: number, cy: number) {
  x.beginPath();
  x.arc(cx, cy, 9, 0, Math.PI * 2);
  x.fill();
}

/* a taotie mask: eyes, brows, curling horns, jaw and the central ridge */
function taotie(x: Ctx, cx: number, cy: number, s: number) {
  x.lineWidth = s * 0.036;
  [-1, 1].forEach((k) => {
    const ex = cx + k * s * 0.34;
    const ey = cy - s * 0.02;
    x.beginPath();
    x.ellipse(ex, ey, s * 0.13, s * 0.085, 0, 0, Math.PI * 2);
    x.stroke();
    x.beginPath();
    x.arc(ex, ey, s * 0.045, 0, Math.PI * 2);
    x.fill();
    x.beginPath();
    x.moveTo(cx + k * s * 0.06, cy - s * 0.2);
    x.bezierCurveTo(cx + k * s * 0.35, cy - s * 0.44, cx + k * s * 0.8, cy - s * 0.4, cx + k * s * 0.82, cy - s * 0.12);
    x.bezierCurveTo(cx + k * s * 0.84, cy + s * 0.03, cx + k * s * 0.66, cy + s * 0.07, cx + k * s * 0.62, cy - s * 0.06);
    x.stroke();
    x.beginPath();
    x.moveTo(cx + k * s * 0.16, cy - s * 0.13);
    x.quadraticCurveTo(cx + k * s * 0.34, cy - s * 0.22, cx + k * s * 0.54, cy - s * 0.1);
    x.stroke();
    x.beginPath();
    x.moveTo(cx + k * s * 0.1, cy + s * 0.2);
    x.bezierCurveTo(cx + k * s * 0.3, cy + s * 0.37, cx + k * s * 0.57, cy + s * 0.33, cx + k * s * 0.57, cy + s * 0.18);
    x.bezierCurveTo(cx + k * s * 0.57, cy + s * 0.1, cx + k * s * 0.46, cy + s * 0.08, cx + k * s * 0.44, cy + s * 0.16);
    x.stroke();
    x.save();
    x.lineWidth = s * 0.026;
    leiwen(x, cx + k * s * 0.9, cy + s * 0.22, k * s * 0.08);
    x.restore();
  });
  x.beginPath();
  x.moveTo(cx, cy - s * 0.26);
  x.lineTo(cx, cy + s * 0.28);
  x.stroke();
}

/* ---------- vessel geometry ---------- */

/* lathe a round vessel wall from an outer profile; the inner wall is an inward offset */
function latheVessel(knots: [number, number][], thick: number) {
  const outer = new THREE.SplineCurve(knots.map(([r, y]) => new THREE.Vector2(r, y))).getSpacedPoints(120);
  const pts = [new THREE.Vector2(0, outer[0].y)].concat(outer);
  const top = outer[outer.length - 1];
  pts.push(new THREE.Vector2(top.x - thick * 0.3, top.y + thick * 0.45), new THREE.Vector2(top.x - thick, top.y + thick * 0.1));
  for (let i = outer.length - 2; i >= 1; i--) {
    const a = outer[i - 1];
    const b = outer[i + 1];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const Ln = Math.hypot(tx, ty) || 1;
    pts.push(new THREE.Vector2(Math.max(outer[i].x - (ty / Ln) * thick, 0.002), outer[i].y + (tx / Ln) * thick));
  }
  pts.push(new THREE.Vector2(0, outer[0].y + thick));
  const g = new THREE.LatheGeometry(pts, 128);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/* a rounded-rectangle wall extruded upward from y = 0 to h */
function roundRect(path: THREE.Path, w: number, d: number, r: number) {
  const x0 = -w / 2;
  const y0 = -d / 2;
  path.moveTo(x0 + r, y0);
  path.lineTo(x0 + w - r, y0);
  path.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  path.lineTo(x0 + w, y0 + d - r);
  path.quadraticCurveTo(x0 + w, y0 + d, x0 + w - r, y0 + d);
  path.lineTo(x0 + r, y0 + d);
  path.quadraticCurveTo(x0, y0 + d, x0, y0 + d - r);
  path.lineTo(x0, y0 + r);
  path.quadraticCurveTo(x0, y0, x0 + r, y0);
}

function boxWall(w: number, d: number, thick: number, h: number, r: number) {
  const s = new THREE.Shape();
  roundRect(s, w, d, r);
  const hole = new THREE.Path();
  roundRect(hole, w - thick * 2, d - thick * 2, Math.max(r - thick * 0.5, 0.01));
  s.holes.push(hole);
  const bev = Math.min(0.012, thick * 0.3);
  const g = new THREE.ExtrudeGeometry(s, { depth: h - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bev, 0);
  return g;
}

/* a notched flange (扉棱), protruding along +x from its base */
function flangeGeometry(h: number, depth: number, t: number) {
  const s = new THREE.Shape();
  const n = 5;
  const st = h / n;
  s.moveTo(0, 0);
  for (let i = 0; i < n; i++) {
    const y0 = i * st;
    s.lineTo(depth, y0 + st * 0.1);
    s.lineTo(depth, y0 + st * 0.7);
    s.lineTo(depth * 0.42, y0 + st * 0.82);
    s.lineTo(depth * 0.42, y0 + st);
  }
  s.lineTo(0, h);
  s.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1 });
  g.translate(0, 0, -t / 2);
  return g;
}

/* the inner glow: light rising inside the vessel up to the fill line */
interface PatchOpts {
  name: string;
  decor: THREE.Texture;
  decorCol: THREE.Color;
  decorAmt: number;
  height: number;
  tint?: string;
  box?: [number, number];
}

function patch(G: Shared, mat: THREE.MeshStandardMaterial, v: Vessel, o: PatchOpts) {
  mat.userData.env = mat.envMapIntensity;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uFill: v.u.fill,
      uGlow: v.u.glow,
      uTime: G.time,
      uDecor: { value: o.decor },
      uDecorCol: { value: o.decorCol },
      uDecorAmt: { value: o.decorAmt },
      uH: { value: o.height },
      uBox: { value: new THREE.Vector2(o.box ? o.box[0] : 1, o.box ? o.box[1] : 1) },
    });
    const defs = o.box ? "#define YAN_BOX\n" : "";
    sh.vertexShader =
      defs +
      "varying float vY;\nvarying float vA;\nvarying float vWA;\nvarying vec3 vOP;\nvarying vec3 vON;\n" +
      sh.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvY = position.y;\nvA = atan(position.x, position.z);\nvOP = position;\nvON = normal;\nvec4 yWP = modelMatrix * vec4(position, 1.0);\nvWA = atan(yWP.x, yWP.z);",
      );
    sh.fragmentShader =
      defs +
      "uniform float uFill;\nuniform vec3 uGlow;\nuniform float uTime;\nuniform sampler2D uDecor;\nuniform vec3 uDecorCol;\nuniform float uDecorAmt;\nuniform float uH;\nuniform vec2 uBox;\nvarying float vY;\nvarying float vA;\nvarying float vWA;\nvarying vec3 vOP;\nvarying vec3 vON;\n" +
      sh.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
#ifdef YAN_BOX
  vec2 yUV = abs(vON.z) >= abs(vON.x) ? vec2((vOP.x / uBox.x + 0.5) * 0.5, vY / uH) : vec2(0.5 + (vOP.z / uBox.y + 0.5) * 0.5, vY / uH);
  float yOut = clamp(step(uBox.x * 0.5 - 0.02, abs(vOP.x)) + step(uBox.y * 0.5 - 0.02, abs(vOP.z)), 0.0, 1.0) * step(abs(vON.y), 0.5);
  float yDec = texture2D(uDecor, clamp(yUV, 0.001, 0.999)).a * yOut;
#else
  float yu1 = vA / 6.28318 + 0.5;
  float yu2 = fract(yu1 + 0.5) - 0.5;
  float yu = fwidth(yu1) <= fwidth(yu2) ? yu1 : yu2;
  float yDec = texture2D(uDecor, vec2(yu, clamp(vY / uH, 0.0, 1.0))).a;
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, uDecorCol, yDec * uDecorAmt);
  ${o.tint || ""}`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
  float yW = 0.012 * sin(vWA * 5.0 + uTime * 1.6) + 0.006 * sin(vWA * 11.0 - uTime * 2.4);
  float yL = uFill + yW;
  float yBelow = smoothstep(yL + 0.02, yL - 0.035, vY);
  float yEdge = exp(-pow((vY - yL) / 0.016, 2.0));
  float yFace = clamp(abs(normal.z), 0.0, 1.0);
#ifdef YAN_BOX
  totalEmissiveRadiance += uGlow * (yBelow * (0.1 + 0.9 * yDec) * (0.45 + 0.55 * yFace) + yEdge * 0.6 * yDec);
#else
  totalEmissiveRadiance += uGlow * (yBelow * (0.12 + 0.38 * yFace) + yEdge * 1.8 * yFace);
#endif`,
        );
  };
  mat.customProgramCacheKey = () => "yan-" + o.name;
}

function buildJar(G: Shared, v: Vessel) {
  const H = 1.17;
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#a7cdb6"), roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.1, side: THREE.DoubleSide });
  const decor = decorTexture(G, H, (x, W, y) => {
    lotus(x, W, y(0.36), y(0.07), 16);
    ring(x, W, y(0.38), 4);
    ruyi(x, W, y(0.9), y(0.74), 8);
    ring(x, W, y(0.92), 4);
    meander(x, W, y(1.115), y(1.06));
  });
  patch(G, mat, v, { name: "jar", decor, decorCol: new THREE.Color("#3b6c55"), decorAmt: 0.55, height: H, tint: "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.42,.2,.09), smoothstep(.034,.02,vY));" });
  v.group.add(
    new THREE.Mesh(
      latheVessel([[0.4, 0], [0.42, 0.025], [0.4, 0.05], [0.47, 0.1], [0.6, 0.22], [0.72, 0.38], [0.78, 0.55], [0.76, 0.7], [0.66, 0.84], [0.5, 0.95], [0.37, 1.01], [0.33, 1.05], [0.33, 1.12], [0.36, 1.155]], 0.028),
      mat,
    ),
  );
  v.mats.push(mat);
  Object.assign(v, { baseR: 0.42, size: { h: 1.17, w: 1.58 }, fillMin: 0.06, fillMax: 0.99, mouthY: 1.16, mouthR: 0.28, elev: 0.26, frac: 0.58, coinScale: 1, flareSize: 0.38, spin: 0.16, glowCol: new THREE.Color("#eef5c4"), glowK: 0.6 });
  v.landY = () => v.mouthY - 0.06;
}

function buildVase(G: Shared, v: Vessel) {
  const H = 1.6;
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#a3150b"), roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.25, side: THREE.DoubleSide });
  const decor = decorTexture(G, H, (x, W, y) => {
    meander(x, W, y(1.26), y(1.2));
    ring(x, W, y(1.43), 4);
    ring(x, W, y(0.075), 4);
  });
  patch(G, mat, v, {
    name: "vase",
    decor,
    decorCol: new THREE.Color("#d9a441"),
    decorAmt: 0.9,
    height: H,
    tint: "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.84,.77,.64), smoothstep(1.44,1.53,vY)*.92); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.06,.006,.004), smoothstep(.36,.05,vY)*.72); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.42,.2,.09), smoothstep(.032,.018,vY));",
  });
  v.group.add(
    new THREE.Mesh(
      latheVessel([[0.27, 0], [0.29, 0.03], [0.31, 0.1], [0.36, 0.32], [0.45, 0.62], [0.55, 0.9], [0.61, 1.06], [0.6, 1.16], [0.5, 1.28], [0.33, 1.37], [0.18, 1.43], [0.14, 1.47], [0.145, 1.52], [0.18, 1.55], [0.175, 1.58]], 0.022),
      mat,
    ),
  );
  v.mats.push(mat);
  Object.assign(v, { baseR: 0.3, size: { h: 1.6, w: 1.26 }, fillMin: 0.06, fillMax: 1.36, mouthY: 1.59, mouthR: 0.1, elev: 0.2, frac: 0.58, coinScale: 0.72, flareSize: 0.3, spin: 0.13, glowCol: new THREE.Color("#ff7a40"), glowK: 0.7 });
  v.landY = () => v.mouthY - 0.05;
}

/* the jackpot: a square bronze cauldron (方鼎) on four column legs */
function buildFangding(G: Shared, v: Vessel) {
  const BW = 1.36;
  const BD = 0.96;
  const BH = 0.92;
  const base = 0.5;
  const hx = BW / 2;
  const hz = BD / 2;
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#cf9f4a"), metalness: 1, roughness: 0.3, envMapIntensity: 1.3 });
  const decor = decorTexture(G, BH, (x, W, y) => {
    const half = W / 2;
    ([[0, half, true], [half, W, false]] as const).forEach(([x0, x1, front]) => {
      meanderSpan(x, x0 + 18, x1 - 18, y(0.86), y(0.75));
      const top = y(0.7);
      const bot = y(0.07);
      const l = x0 + 40;
      const r = x1 - 40;
      x.lineWidth = 6;
      x.strokeRect(l, top, r - l, bot - top);
      for (let yy = top + 30; yy < bot - 20; yy += 44) {
        stud(x, l + 22, yy);
        stud(x, r - 22, yy);
      }
      for (let xx = l + 66; xx < r - 44; xx += 44) stud(x, xx, bot - 22);
      x.save();
      x.globalAlpha = 0.38;
      x.lineWidth = 2.5;
      for (let yy = top + 44; yy < bot - 62; yy += 46) for (let xx = l + 66; xx < r - 54; xx += 46) leiwen(x, xx, yy, 14);
      x.restore();
      if (front) taotie(x, (l + r) / 2, (top + bot) / 2 - 24, (r - l) * 0.42);
      else {
        x.lineWidth = 10;
        [-1, 1].forEach((k) => {
          x.beginPath();
          x.ellipse((l + r) / 2 + k * (r - l) * 0.2, (top + bot) / 2 - 30, 34, 22, 0, 0, Math.PI * 2);
          x.stroke();
          x.beginPath();
          x.arc((l + r) / 2 + k * (r - l) * 0.2, (top + bot) / 2 - 30, 10, 0, Math.PI * 2);
          x.fill();
        });
      }
    });
  });
  patch(G, mat, v, { name: "fangding", decor, decorCol: new THREE.Color("#2e210d"), decorAmt: 0.85, height: BH, box: [BW, BD] });
  const plain = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#c4943f"), metalness: 1, roughness: 0.34, envMapIntensity: 1.3 });
  plain.userData.env = 1.3;
  const body = new THREE.Mesh(boxWall(BW, BD, 0.06, BH, 0.045), mat);
  body.position.y = base;
  v.group.add(body);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(BW - 0.1, 0.04, BD - 0.1), plain);
  floor.position.y = base + 0.03;
  v.group.add(floor);
  const lip = new THREE.Mesh(boxWall(BW + 0.1, BD + 0.1, 0.12, 0.07, 0.05), plain);
  lip.position.y = base + BH - 0.05;
  v.group.add(lip);
  const fl = flangeGeometry(0.64, 0.065, 0.026);
  const cx = hx - 0.012;
  const cz = hz - 0.012;
  [[0, hz, Math.PI / 2], [0, -hz, -Math.PI / 2], [hx, 0, 0], [-hx, 0, Math.PI], [cx, cz, Math.atan2(hz, hx)], [-cx, cz, Math.atan2(hz, -hx)], [cx, -cz, Math.atan2(-hz, hx)], [-cx, -cz, Math.atan2(-hz, -hx)]].forEach(
    ([px, pz, phi]) => {
      const m = new THREE.Mesh(fl, plain);
      m.position.set(px, base + 0.09, pz);
      m.rotation.y = -phi;
      v.group.add(m);
    },
  );
  const legGeo = new THREE.CylinderGeometry(0.085, 0.075, 0.52, 28);
  const colGeo = new THREE.CylinderGeometry(0.115, 0.1, 0.11, 28);
  const footGeo = new THREE.CylinderGeometry(0.08, 0.098, 0.045, 28);
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
    const lx = sx * (hx - 0.2);
    const lz = sz * (hz - 0.16);
    const leg = new THREE.Mesh(legGeo, plain);
    leg.position.set(lx, 0.27, lz);
    v.group.add(leg);
    const col = new THREE.Mesh(colGeo, plain);
    col.position.set(lx, base - 0.03, lz);
    v.group.add(col);
    const ft = new THREE.Mesh(footGeo, plain);
    ft.position.set(lx, 0.022, lz);
    v.group.add(ft);
  });
  const ear = new THREE.Shape();
  ear.moveTo(-0.17, 0);
  ear.lineTo(0.17, 0);
  ear.lineTo(0.2, 0.42);
  ear.lineTo(-0.2, 0.42);
  ear.lineTo(-0.17, 0);
  const eh = new THREE.Path();
  eh.moveTo(-0.095, 0.08);
  eh.lineTo(0.095, 0.08);
  eh.lineTo(0.115, 0.33);
  eh.lineTo(-0.115, 0.33);
  eh.lineTo(-0.095, 0.08);
  ear.holes.push(eh);
  const earGeo = new THREE.ExtrudeGeometry(ear, { depth: 0.09, bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.014, bevelSegments: 2 });
  earGeo.translate(0, 0, -0.045);
  [-1, 1].forEach((sgn) => {
    const e = new THREE.Mesh(earGeo, plain);
    e.position.set(sgn * (hx - 0.01), base + BH + 0.01, 0);
    e.rotation.y = Math.PI / 2;
    v.group.add(e);
  });
  const light = new THREE.Mesh(new THREE.PlaneGeometry(BW - 0.12, BD - 0.12), new THREE.MeshBasicMaterial({ map: G.lightTex, color: new THREE.Color("#ffcf73") }));
  light.rotation.x = -Math.PI / 2;
  v.group.add(light);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.58, 4.5, 48, 1, true), beamMaterial());
  beam.scale.set(1, 1, 0.72);
  beam.position.y = base + BH + 2.25;
  beam.visible = false;
  v.group.add(beam);
  v.mats.push(mat, plain);
  v.group.rotation.y = 0.6;
  Object.assign(v, { light, beam, fillOffset: base, size: { h: 1.86, w: 1.72 }, fillMin: 0.06, fillMax: 0.86, mouthY: base + BH + 0.02, mouthR: 0.42, elev: 0.36, frac: 0.66, coinScale: 1.2, flareSize: 0.7, spin: 0.07, glowCol: new THREE.Color("#ffc65a"), glowK: 0.9 });
  v.landY = () => v.fillOffset + lerp(v.fillMin, v.fillMax, v.lvl) + 0.03;
}

/* rosewood display stands: a turned round stand for the porcelain, a two-tier plinth for the cauldron */
function buildStand(v: Vessel) {
  const wood = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#3a1a0e"), roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.9 });
  wood.userData.env = 0.9;
  v.mats.push(wood);
  const g = new THREE.Group();
  if (v.kind === "gold") {
    const a = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 1.14), wood);
    a.position.y = 0.03;
    g.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.03, 1.04), wood);
    b.position.y = 0.075;
    g.add(b);
    v.footprint = [1.55, 1.2];
    return { g, h: 0.09 };
  }
  const R = v.baseR;
  const pts = [[0, 0], [R * 1.22, 0], [R * 1.26, 0.018], [R * 1.2, 0.034], [R * 1.1, 0.048], [R * 1.05, 0.07], [R * 1.14, 0.086], [R * 1.2, 0.098], [R * 1.17, 0.11], [0, 0.11]].map(([r, y]) => new THREE.Vector2(r, y));
  g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 96), wood));
  v.footprint = [R * 2.6, R * 2.6];
  return { g, h: 0.11 };
}

function buildVessel(G: Shared, kind: Kind, view: HTMLElement): Vessel {
  const scene = new THREE.Scene();
  scene.environment = G.env;
  const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  const key = new THREE.DirectionalLight(new THREE.Color("#ffe3bd"), 1.5);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(new THREE.Color("#a9c2ff"), 1.1);
  rim.position.set(4, 2.5, -5);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(new THREE.Color("#3a2a1c"), new THREE.Color("#2a0a05"), 0.5);
  scene.add(hemi);
  const group = new THREE.Group();
  scene.add(group);
  const v = {
    kind,
    view,
    scene,
    cam,
    group,
    u: { fill: { value: 0 }, glow: { value: new THREE.Color(0, 0, 0) } },
    lights: [key, rim, hemi],
    lightBase: [1.5, 1.1, 0.5],
    mats: [],
    lvl: 0,
    dim: 0,
    dimT: 0,
    surge: 0,
    surgeT: 0,
    shake: 0,
    beamA: 0,
    beamT: 0,
    flash: 0,
    coins: [],
    active: false,
    fillOffset: 0,
    topY: 2,
    mouthB: 0,
  } as unknown as Vessel;
  ({ jade: buildJar, cin: buildVase, gold: buildFangding })[kind](G, v);
  // set the vessel on a wooden stand: the stand turns with it, the vessel alone rocks during a draw
  const stand = buildStand(v);
  const body = new THREE.Group();
  while (v.group.children.length) body.add(v.group.children[0]);
  body.position.y = stand.h;
  v.group.add(body);
  v.group.add(stand.g);
  v.body = body;
  v.standH = stand.h;
  v.mouthY += stand.h;
  v.size.h += stand.h;
  const land = v.landY;
  v.landY = () => land() + stand.h;
  // contact shadow and the vessel's light spilling onto the altar
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: G.shadowTex, transparent: true, depthWrite: false, opacity: 0.9 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.scale.set(v.footprint[0] * 1.35, v.footprint[1] * 1.35, 1);
  scene.add(shadow);
  v.spill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: G.flareTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(0, 0, 0) }),
  );
  v.spill.rotation.x = -Math.PI / 2;
  v.spill.position.y = 0.004;
  v.spill.scale.set(v.footprint[0] * 1.8, v.footprint[1] * 1.8, 1);
  scene.add(v.spill);
  v.inst = new THREE.InstancedMesh(G.coinGeo, G.coinMat, 26);
  v.inst.frustumCulled = false;
  scene.add(v.inst);
  for (let i = 0; i < 26; i++) v.coins.push({ on: false, x: 0, y: 0, z: 0, vy: 0, rx: 0, ry: 0, vr: 0 });
  v.flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: G.flareTex, color: new THREE.Color(FLARE[kind]), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
  v.flare.scale.setScalar(v.flareSize);
  scene.add(v.flare);
  return v;
}

function disposeScene(s: THREE.Scene) {
  const done = new Set<{ dispose: () => void }>();
  s.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.Sprite).isSprite) done.add((o as THREE.Sprite).material);
    else if (m.isMesh) {
      done.add(m.geometry);
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => done.add(x));
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    }
  });
  done.forEach((x) => x.dispose());
}

/**
 * Builds the three vessels into `host` (the `.vessels` grid). `views` are the column elements by pot index;
 * each gets a `--mouthB` custom property for positioning the bamboo slip. Returns null when WebGL is unavailable.
 */
export function createScene(host: HTMLElement, views: HTMLElement[], opts: SceneOptions): VesselScene | null {
  const canvas = document.createElement("canvas");
  canvas.className = "gl";
  canvas.setAttribute("aria-hidden", "true");
  host.prepend(canvas);

  let G: Shared;
  let vs: Vessel[];
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    THREE.ColorManagement.legacyMode = false;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setScissorTest(true);
    const pm = new THREE.PMREMGenerator(renderer);
    const es = envScene();
    const env = pm.fromScene(es, 0.035).texture;
    pm.dispose();
    disposeScene(es);
    G = {
      renderer,
      aniso: renderer.capabilities.getMaxAnisotropy(),
      time: { value: 0 },
      decors: [],
      repaints: [],
      env,
      coinGeo: coinGeometry(),
      coinMat: new THREE.MeshStandardMaterial({ color: new THREE.Color("#e6bd62"), metalness: 1, roughness: 0.26 }),
      flareTex: flareTexture(),
      lightTex: lightTexture(),
      shadowTex: shadowTexture(),
    };
    vs = KINDS.map((k, i) => buildVessel(G, k, views[i]));
  } catch (e) {
    console.warn("3D unavailable", e);
    renderer?.dispose();
    canvas.remove();
    return null;
  }

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer!.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer!.setSize(w, h, false);
    const tf = Math.tan((24 * Math.PI) / 360);
    vs.forEach((v) => {
      const r = v.view.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const aspect = r.width / r.height;
      const needH = Math.max(v.size.h / v.frac, v.size.w / 0.9 / aspect);
      const dist = needH / (2 * tf);
      const cy = needH / 2 - needH * 0.15;
      v.cam.aspect = aspect;
      v.cam.position.set(0, cy + Math.sin(v.elev) * dist, Math.cos(v.elev) * dist);
      v.cam.lookAt(0, cy, 0);
      v.cam.updateProjectionMatrix();
      v.topY = cy + needH * 0.55;
      const m = new THREE.Vector3(0, v.mouthY, 0).project(v.cam);
      v.mouthB = (m.y * 0.5 + 0.5) * r.height;
      v.view.style.setProperty("--mouthB", v.mouthB.toFixed(1) + "px");
    });
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const dummy = new THREE.Object3D();
  let lastCoin = 0;
  const frameView = (v: Vessel, dt: number, cr: DOMRect) => {
    const t = G.time.value;
    const lvl = v.lvl;
    const ease = (rate: number) => Math.min(1, dt * rate);
    v.dim = lerp(v.dim, v.dimT, ease(4));
    v.surge = lerp(v.surge, v.surgeT, ease(3));
    v.beamA = lerp(v.beamA, v.beamT, ease(2.5));
    if (!opts.reduce) v.group.rotation.y += dt * v.spin * (v.active ? 1.8 : 1);
    const b = v.body;
    if (v.shake > 0) {
      b.rotation.z = Math.sin(t * 38) * 0.075;
      b.rotation.x = Math.cos(t * 31) * 0.055;
      b.position.y = v.standH + Math.abs(Math.sin(t * 38)) * 0.035;
    } else {
      b.rotation.z *= 0.82;
      b.rotation.x *= 0.82;
      b.position.y = v.standH + (b.position.y - v.standH) * 0.82;
    }
    const fill = lerp(v.fillMin, v.fillMax, lvl);
    const pulse = lvl >= 0.9 && !opts.reduce ? 1 + 0.35 * Math.sin(t * 4.2) : 1;
    const lk = 1 - 0.88 * v.dim;
    v.u.fill.value = fill;
    v.u.glow.value.copy(v.glowCol).multiplyScalar(v.glowK * (0.55 + 0.7 * lvl) * pulse * (1 + 2.6 * v.surge) * (1 - 0.85 * v.dim));
    v.lights.forEach((l, i) => (l.intensity = v.lightBase[i] * lk));
    v.mats.forEach((m) => (m.envMapIntensity = m.userData.env * lk));
    if (v.light) {
      v.light.position.y = v.fillOffset + fill;
      v.light.material.color.copy(v.glowCol).multiplyScalar((0.8 + 0.6 * lvl) * pulse * (1 + 0.9 * v.surge) * lk);
    }
    if (v.beam) {
      const a = Math.max(v.beamA, (0.04 + 0.1 * lvl) * (1 - v.dim));
      v.beam.material.uniforms.uA.value = a;
      v.beam.visible = a > 0.01;
    }
    v.spill.material.color.copy(v.glowCol).multiplyScalar((0.06 + 0.22 * lvl) * pulse * (1 + 1.6 * v.surge) * lk);
    const landY = v.landY();
    v.coins.forEach((c, i) => {
      if (c.on) {
        c.vy -= 5.2 * dt;
        c.y += c.vy * dt;
        c.rx += c.vr * dt;
        c.ry += c.vr * 0.6 * dt;
        if (c.y < landY) {
          c.on = false;
          v.flash = Math.min(1, v.flash + 0.55);
          const now = performance.now();
          if (now - lastCoin > 70) {
            opts.onCoin?.();
            lastCoin = now;
          }
        }
      }
      if (c.on) {
        dummy.position.set(c.x, c.y, c.z);
        dummy.rotation.set(c.rx, c.ry, 0);
        dummy.scale.setScalar(v.coinScale);
      } else dummy.scale.setScalar(0);
      dummy.updateMatrix();
      v.inst.setMatrixAt(i, dummy.matrix);
    });
    v.inst.instanceMatrix.needsUpdate = true;
    v.flash = Math.max(0, v.flash - dt * 2.2);
    v.flare.material.opacity = v.flash * 0.45;
    v.flare.position.set(0, landY + 0.02, 0);
    const r = v.view.getBoundingClientRect();
    const x = r.left - cr.left;
    const y = cr.bottom - r.bottom;
    G.renderer.setViewport(x, y, r.width, r.height);
    G.renderer.setScissor(x, y, r.width, r.height);
    G.renderer.render(v.scene, v.cam);
  };

  let visible = true;
  let glOk = true;
  const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting));
  io.observe(host);
  const onLost = (e: Event) => {
    e.preventDefault();
    glOk = false;
    opts.onGl?.(false);
  };
  const onRestored = () => {
    glOk = true;
    resize();
    opts.onGl?.(true);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!visible || !glOk || document.hidden) return;
    G.time.value += dt;
    const cr = canvas.getBoundingClientRect();
    vs.forEach((v) => frameView(v, dt, cr));
  };
  raf = requestAnimationFrame(loop);
  if (document.fonts?.ready) document.fonts.ready.then(() => G.repaints.forEach((f) => f())).catch(() => {});

  return {
    setLevel(pot, lvl) {
      if (vs[pot]) vs[pot].lvl = Math.max(0, Math.min(1, lvl));
    },
    dropCoins(pot, n) {
      const v = vs[pot];
      if (!v || opts.reduce) return;
      let k = 0;
      for (const c of v.coins) {
        if (k >= n) break;
        if (c.on) continue;
        k++;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * v.mouthR * 0.55;
        Object.assign(c, { on: true, x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: v.topY + 0.1 + k * 0.2 + Math.random() * 0.12, vy: -0.5 - Math.random() * 0.4, rx: Math.random() * 6, ry: Math.random() * 6, vr: 4 + Math.random() * 6 });
      }
    },
    setActive(pot) {
      vs.forEach((v, i) => {
        v.dimT = pot === null || pot === i ? 0 : 1;
        v.active = pot === i;
      });
    },
    setShake(pot, on) {
      if (vs[pot]) vs[pot].shake = on ? 1 : 0;
    },
    surge(pot, k) {
      if (vs[pot]) vs[pot].surgeT = k;
    },
    beam(on) {
      vs[2].beamT = on ? 1 : 0;
    },
    mouthOffset(pot) {
      return vs[pot]?.mouthB ?? 0;
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      vs.forEach((v) => disposeScene(v.scene));
      [G.env, G.flareTex, G.lightTex, G.shadowTex, ...G.decors].forEach((t) => t.dispose());
      G.coinGeo.dispose();
      G.coinMat.dispose();
      G.renderer.dispose();
      G.renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/* ---------- embers and paper flakes: a 2D overlay over the whole stage ---------- */

export interface Motes {
  /** paper confetti from (x, y) in stage px */
  burst(x: number, y: number, n: number, cols: string[], power: number): void;
  dispose(): void;
}

interface Flake {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  ph: number;
  life: number;
  col: string;
}

export function createMotes(canvas: HTMLCanvasElement, stage: HTMLElement, reduce: boolean): Motes {
  const mx = canvas.getContext("2d");
  let MW = 0;
  let MH = 0;
  let flakes: Flake[] = [];
  const motes = Array.from({ length: 44 }, () => ({ x: Math.random(), y: Math.random(), vy: 8 + Math.random() * 18, ph: Math.random() * 6, r: 0.6 + Math.random() * 1.1, a: 0.15 + Math.random() * 0.35 }));
  const resize = () => {
    if (!mx) return;
    const r = stage.getBoundingClientRect();
    const d = Math.min(2, window.devicePixelRatio || 1);
    MW = r.width;
    MH = r.height;
    canvas.width = Math.round(MW * d);
    canvas.height = Math.round(MH * d);
    canvas.style.width = MW + "px";
    canvas.style.height = MH + "px";
    mx.setTransform(d, 0, 0, d, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  let visible = true;
  const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting));
  io.observe(stage);

  const draw = (dt: number) => {
    if (!mx) return;
    mx.clearRect(0, 0, MW, MH);
    const t = performance.now() / 1000;
    for (const m of motes) {
      if (!reduce) {
        m.y -= (m.vy * dt) / MH;
        m.x += (Math.sin(m.ph + t * 0.6) * 6 * dt) / MW;
        if (m.y < -0.02) {
          m.y = 1.02;
          m.x = Math.random();
        }
      }
      mx.globalAlpha = m.a * (reduce ? 0.8 : 0.6 + 0.4 * Math.sin(t * 2 + m.ph));
      mx.fillStyle = "#e9c36a";
      mx.beginPath();
      mx.arc(m.x * MW, m.y * MH, m.r, 0, Math.PI * 2);
      mx.fill();
    }
    mx.globalAlpha = 1;
    const k = dt * 60;
    const next: Flake[] = [];
    for (const q of flakes) {
      q.vy += 0.16 * k;
      q.vx *= Math.pow(0.986, k);
      q.vy *= Math.pow(0.986, k);
      q.ph += 0.12 * k;
      q.x += (q.vx + Math.sin(q.ph) * 0.7) * k;
      q.y += q.vy * k;
      q.rot += q.vr * k;
      q.life -= 0.0065 * k;
      if (q.life <= 0 || q.y > MH + 20) continue;
      mx.save();
      mx.globalAlpha = Math.min(1, q.life * 1.4);
      mx.translate(q.x, q.y);
      mx.rotate(q.rot);
      mx.scale(1, Math.abs(Math.cos(q.ph)) * 0.8 + 0.2);
      mx.fillStyle = q.col;
      mx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
      mx.restore();
      next.push(q);
    }
    flakes = next;
  };

  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!visible || document.hidden) return;
    draw(dt);
  };
  raf = requestAnimationFrame(loop);

  return {
    burst(ox, oy, n, cols, power) {
      if (reduce) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * power;
        flakes.push({ x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5, w: 3 + Math.random() * 6, h: 2 + Math.random() * 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, ph: Math.random() * 6, life: 1, col: cols[i % cols.length] });
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      flakes = [];
    },
  };
}
