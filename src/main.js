import {
  Application,
  Texture,
  Mesh,
  MeshGeometry,
  Shader,
  Graphics,
  GlProgram,
} from 'pixi.js';
import { preprocess } from './preprocess.js';
import { VERT, FRAG }  from './shaders.js';

const BASE = import.meta.env.BASE_URL;

// Set background image via JS so BASE_URL resolves correctly in both dev and prod
// Scale background to cover + 8% overshoot so transparent PNG edges are always off-screen
const BG_IMG_W = 2848, BG_IMG_H = 1916;
function updateBackground() {
  const scale = Math.max(window.innerWidth / BG_IMG_W, window.innerHeight / BG_IMG_H) * 1.08;
  document.body.style.backgroundSize = `${Math.round(BG_IMG_W * scale)}px ${Math.round(BG_IMG_H * scale)}px`;
}
document.body.style.backgroundImage = `url('${BASE}background.png')`;
document.body.style.backgroundPosition = 'center';
document.body.style.backgroundRepeat = 'no-repeat';
updateBackground();
window.addEventListener('resize', updateBackground);

// ── Layout ────────────────────────────────────────────────────────────────────
const MARGIN    = 0.14;
const RING_FRAC = 0.16;
const HANDLE_R  = 22;
const MESH_SEGS = 20;

// ── State ─────────────────────────────────────────────────────────────────────
let targetAngle  = 0;
let displayAngle = 0;
let isDragging   = false;
let showOverlay  = false;

function curlFromAngle(deg) {
  const t = (deg / 360) * Math.PI * 2;
  return Math.pow(0.5 * (1 - Math.cos(t)), 2);
}

function shortestArc(from, to) {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function buildLeafGeometry(size) {
  const n   = MESH_SEGS + 1;
  const pos = new Float32Array(n * n * 2);
  const uvs = new Float32Array(n * n * 2);
  const idx = new Uint32Array(MESH_SEGS * MESH_SEGS * 6);
  let vi = 0, ui = 0, ii = 0;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const u = ix / MESH_SEGS, v = iy / MESH_SEGS;
      pos[vi++] = (u - 0.5) * size;
      pos[vi++] = (v - 0.5) * size;
      uvs[ui++] = u; uvs[ui++] = v;
    }
  }
  for (let iy = 0; iy < MESH_SEGS; iy++) {
    for (let ix = 0; ix < MESH_SEGS; ix++) {
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      idx[ii++] = a; idx[ii++] = b; idx[ii++] = d;
      idx[ii++] = a; idx[ii++] = d; idx[ii++] = c;
    }
  }
  return new MeshGeometry({ positions: pos, uvs, indices: idx });
}

async function main() {
  function dialSize() {
    return Math.min(window.innerWidth, window.innerHeight) * (1 - MARGIN * 2);
  }

  let size  = dialSize();
  const appEl    = document.getElementById('app');
  const dialGfx = new Graphics();
  app.stage.addChildAt(dialGfx, 0);

  // ── PixiJS app ───────────────────────────────────────────────────────────────
  const app = new Application();
  await app.init({
    width: size, height: size,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  appEl.appendChild(app.canvas);
  appEl.style.width  = size + 'px';
  appEl.style.height = size + 'px';

  // ── Load + preprocess ────────────────────────────────────────────────────────
  async function loadBitmap(path) {
    return createImageBitmap(await (await fetch(BASE + path)).blob());
  }
  const [bmpSummer, bmpFall, bmpWinter, bmpTransition] = await Promise.all([
    loadBitmap('leaf-summer.png'),
    loadBitmap('leaf-fall.png'),
    loadBitmap('leaf-winter.png'),
    loadBitmap('leaf-transition.png'),
  ]);
  const textures = await preprocess(bmpSummer, bmpFall, bmpWinter, bmpTransition);

  // ── GPU textures ─────────────────────────────────────────────────────────────
  const texFallDetail   = Texture.from(textures.fallDetail);
  const texSummerLF     = Texture.from(textures.summerLF);
  const texTransitionLF = Texture.from(textures.transitionLF);
  const texWinterLF     = Texture.from(textures.winterLF);
  const texFallLF       = Texture.from(textures.fallLF);
  const texDelay        = Texture.from(textures.delay);

  // ── Shader ───────────────────────────────────────────────────────────────────
  const glProgram = GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'leaf-season' });
  const shader    = new Shader({
    glProgram,
    resources: {
      uFallDetail:   texFallDetail.source,
      uSummerLF:     texSummerLF.source,
      uTransitionLF: texTransitionLF.source,
      uWinterLF:     texWinterLF.source,
      uFallLF:       texFallLF.source,
      uDelay:        texDelay.source,
      uniforms: {
        uAngle:     { value: 0.0,         type: 'f32' },
        uOverlay:   { value: 0.0,         type: 'f32' },
        uCurl:      { value: 0.0,         type: 'f32' },
        uPivot:     { value: [0.5, 0.78], type: 'vec2<f32>' },
        uAsymmetry: { value: 0.05,        type: 'f32' },
      },
    },
  });

  // ── Leaf mesh ────────────────────────────────────────────────────────────────
  let leafSize = size * 0.72;
  const geometry = buildLeafGeometry(leafSize);
  const leaf     = new Mesh({ geometry, shader });
  leaf.x = size / 2;
  leaf.y = size / 2;
  app.stage.addChild(leaf);

  // ── Handle ───────────────────────────────────────────────────────────────────
  const handleGfx = new Graphics();
  app.stage.addChild(handleGfx);

  // ── Ring radii — SVG inner/outer ratio is 278.65/335.5 ≈ 0.8305 ────────────
  const RING_SCALE      = 0.90;  // ring diameter as fraction of canvas size
  const SVG_INNER_RATIO = 278.65 / 335.5;

  function ringRadii() {
    const outer = size * RING_SCALE / 2;
    return { outer, inner: outer * SVG_INNER_RATIO };
  }

  // ── Draw ring: stroked circle matching the Figma design (#D9D9D9 @ 30%) ──────
  function drawRing() {
    const { outer, inner } = ringRadii();
    const cx = size / 2, cy = size / 2;
    const mid = (outer + inner) / 2;
    const width = outer - inner;
    dialGfx.clear();
    dialGfx.circle(cx, cy, mid)
           .stroke({ color: 0xD9D9D9, alpha: 0.3, width });
  }
  drawRing();

  // ── Pointer / touch drag ─────────────────────────────────────────────────────
  function pointerAngle(e) {
    const rect = app.canvas.getBoundingClientRect();
    const px   = e.clientX ?? e.touches?.[0]?.clientX;
    const py   = e.clientY ?? e.touches?.[0]?.clientY;
    const dx   = px - (rect.left + rect.width  / 2);
    const dy   = py - (rect.top  + rect.height / 2);
    return ((Math.atan2(dy, dx) * 180 / Math.PI + 90) % 360 + 360) % 360;
  }

  function onRing(e) {
    const rect = app.canvas.getBoundingClientRect();
    const px   = e.clientX ?? e.touches?.[0]?.clientX;
    const py   = e.clientY ?? e.touches?.[0]?.clientY;
    const dx   = px - (rect.left + rect.width  / 2);
    const dy   = py - (rect.top  + rect.height / 2);
    const { outer, inner } = ringRadii();
    const d = Math.hypot(dx, dy) / (rect.width / size);
    return d >= inner - 12 && d <= outer + 12;
  }

  app.canvas.addEventListener('pointerdown', e => {
    if (onRing(e)) { isDragging = true; targetAngle = pointerAngle(e); }
  });
  window.addEventListener('pointermove', e => { if (isDragging) targetAngle = pointerAngle(e); });
  window.addEventListener('pointerup',   ()  => { isDragging = false; });

  // ── Static uniforms ───────────────────────────────────────────────────────────
  const u = shader.resources.uniforms.uniforms;
  u.uPivot[0]  = 0.5;
  u.uPivot[1]  = 0.78;
  u.uAsymmetry = 0.05;

  // ── Render loop ───────────────────────────────────────────────────────────────
  app.ticker.add(({ deltaTime }) => {
    const arc    = shortestArc(displayAngle, targetAngle);
    displayAngle = ((displayAngle + arc * 0.08 * deltaTime) % 360 + 360) % 360;

    u.uAngle   = displayAngle / 360;
    u.uOverlay = showOverlay ? 1.0 : 0.0;
    u.uCurl    = curlFromAngle(displayAngle);

    // Handle — white with subtle glass shadow
    const { outer, inner } = ringRadii();
    const cx  = size / 2, cy = size / 2;
    const rad = (displayAngle - 90) * Math.PI / 180;
    const mid = inner + (outer - inner) / 2;
    handleGfx.clear();
    handleGfx.circle(cx + Math.cos(rad) * mid, cy + Math.sin(rad) * mid, HANDLE_R)
             .fill({ color: 0xffffff, alpha: 0.6 });

    document.getElementById('angleReadout').textContent = Math.round(displayAngle) + '°';
    document.getElementById('angleSlider').value = Math.round(displayAngle);
  });

  // ── Debug panel ───────────────────────────────────────────────────────────────
  const debugEl = document.getElementById('debug');
  const toggle  = () => debugEl.classList.toggle('visible');
  document.addEventListener('keydown', e => (e.key === 'd' || e.key === 'D') && toggle());
  document.getElementById('debugTap').addEventListener('click', toggle);
  document.getElementById('angleSlider').addEventListener('input',  e => { targetAngle = +e.target.value; });
  document.getElementById('overlayToggle').addEventListener('change', e => { showOverlay = e.target.checked; });

  // ── Resize ────────────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    size = dialSize();
    app.renderer.resize(size, size);
    appEl.style.width  = size + 'px';
    appEl.style.height = size + 'px';
    leaf.x = size / 2;
    leaf.y = size / 2;
    drawRing();
  });
}

main().catch(console.error);
