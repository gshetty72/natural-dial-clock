/**
 * preprocess.js — runs once at load time on the CPU.
 *
 * Produces five OffscreenCanvases that drive the shader:
 *   fallDetail  (RGBA) — fall image RGB + eroded silhouette in alpha
 *   summerLF    (RGBA) — summer low-freq color, dilated into transparent area
 *   winterLF    (RGBA) — winter low-freq color, dilated into transparent area
 *   fallLF      (RGBA) — fall low-freq color (used for per-pixel normalisation)
 *   delay       (RGBA) — transition delay mask stored in R channel [0..1]
 */

// ─── Integral-image box blur  O(W×H) regardless of radius ────────────────────
function boxBlurGray(data, W, H, radius) {
  const W1 = W + 1;
  const integral = new Float64Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      integral[(y + 1) * W1 + (x + 1)] =
        data[y * W + x]
        + integral[y * W1 + (x + 1)]
        + integral[(y + 1) * W1 + x]
        - integral[y * W1 + x];
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x1 = Math.max(0, x - radius), y1 = Math.max(0, y - radius);
      const x2 = Math.min(W - 1, x + radius), y2 = Math.min(H - 1, y + radius);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const s = integral[(y2 + 1) * W1 + (x2 + 1)]
              - integral[y1 * W1 + (x2 + 1)]
              - integral[(y2 + 1) * W1 + x1]
              + integral[y1 * W1 + x1];
      out[y * W + x] = s / area;
    }
  }
  return out;
}

// ─── BFS distance transform (4-connected, returns distances in pixels) ────────
function bfsDist(W, H, isSource) {
  const dist = new Float32Array(W * H).fill(1e9);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (isSource(i)) { dist[i] = 0; queue[tail++] = i; }
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % W, y = (idx / W) | 0;
    const d1 = dist[idx] + 1;
    if (x > 0    && dist[idx - 1] > d1) { dist[idx - 1] = d1; queue[tail++] = idx - 1; }
    if (x < W-1  && dist[idx + 1] > d1) { dist[idx + 1] = d1; queue[tail++] = idx + 1; }
    if (y > 0    && dist[idx - W] > d1) { dist[idx - W] = d1; queue[tail++] = idx - W; }
    if (y < H-1  && dist[idx + W] > d1) { dist[idx + W] = d1; queue[tail++] = idx + W; }
  }
  return dist;
}

// ─── BFS colour dilation into transparent pixels ──────────────────────────────
function dilateColors(rgba, W, H) {
  const out = new Uint8ClampedArray(rgba);
  const visited = new Uint8Array(W * H);
  const queue   = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (rgba[i * 4 + 3] > 20) { visited[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % W, y = (idx / W) | 0;
    const nb = [idx-1, idx+1, idx-W, idx+W];
    const ok = [x>0, x<W-1, y>0, y<H-1];
    for (let k = 0; k < 4; k++) {
      if (!ok[k]) continue;
      const ni = nb[k];
      if (visited[ni]) continue;
      visited[ni] = 1;
      out[ni * 4]     = out[idx * 4];
      out[ni * 4 + 1] = out[idx * 4 + 1];
      out[ni * 4 + 2] = out[idx * 4 + 2];
      out[ni * 4 + 3] = 255;
      queue[tail++] = ni;
    }
  }
  return out;
}

// ─── Morphological alpha erosion ─────────────────────────────────────────────
function erodeAlpha(alphaF32, W, H, radiusPx) {
  // Distance from each opaque pixel to nearest transparent pixel.
  // Pixels closer than radiusPx to the edge become transparent.
  const dToEdge = bfsDist(W, H, i => alphaF32[i] < 0.5);
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = dToEdge[i] >= radiusPx ? alphaF32[i] : 0;
  }
  return out;
}

// ─── Deterministic low-frequency noise ───────────────────────────────────────
function smoothNoise(W, H, featureSize) {
  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Deterministic integer hash → [0,1]
      let h = (x * 2654435761 ^ y * 2246822519) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      raw[y * W + x] = (h & 0xffff) / 0xffff;
    }
  }
  const blurred = boxBlurGray(raw, W, H, featureSize);
  let lo = Infinity, hi = -Infinity;
  for (const v of blurred) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return blurred.map(v => (v - lo) / (hi - lo + 1e-9));
}

// ─── Canvas gaussian blur (GPU-accelerated via 2D filter) ────────────────────
function canvasBlur(offscreenCanvas, blurPx) {
  const { width: W, height: H } = offscreenCanvas;
  const dst = new OffscreenCanvas(W, H);
  const ctx = dst.getContext('2d');
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(offscreenCanvas, 0, 0);
  ctx.filter = 'none';
  return dst;
}

// ─── Main export ─────────────────────────────────────────────────────────────
export async function preprocess(summerBmp, fallBmp, winterBmp, transitionBmp) {
  const W = fallBmp.width, H = fallBmp.height;

  // Helper: draw ImageBitmap → raw RGBA Uint8ClampedArray
  function getPixels(bmp) {
    const c = new OffscreenCanvas(W, H);
    c.getContext('2d').drawImage(bmp, 0, 0, W, H);
    return c.getContext('2d').getImageData(0, 0, W, H);
  }

  const sumID = getPixels(summerBmp);
  const falID = getPixels(fallBmp);
  const winID = getPixels(winterBmp);
  const traID = getPixels(transitionBmp);
  const sumPx = sumID.data, falPx = falID.data, winPx = winID.data, traPx = traID.data;

  // ── Fall alpha + luminance ────────────────────────────────────────────────
  const fallAlpha = new Float32Array(W * H);
  const fallLum   = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    fallAlpha[i] = falPx[j + 3] / 255;
    if (fallAlpha[i] > 0.1) {
      fallLum[i] = 0.299 * falPx[j] / 255
                 + 0.587 * falPx[j + 1] / 255
                 + 0.114 * falPx[j + 2] / 255;
    }
  }

  // ── Vein detection (dark pixels relative to local average) ───────────────
  // radius=18 gives ~36px blur — captures the inter-vein level
  const fallLumBlur = boxBlurGray(fallLum, W, H, 18);
  const isVeinPx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // Pixel is a vein if it is ≥10% darker than its blurred neighbourhood
    if (fallAlpha[i] > 0.5 && fallLumBlur[i] - fallLum[i] > 0.10) {
      isVeinPx[i] = 1;
    }
  }

  // Proximity to nearest vein: 1.0 on vein, falling to 0 at 50px
  const veinDistPx   = bfsDist(W, H, i => isVeinPx[i] === 1);
  const veinProximity = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    veinProximity[i] = fallAlpha[i] > 0.5
      ? Math.max(0, 1 - veinDistPx[i] / 50)
      : 0;
  }

  // ── Edge distance (distance from transparent boundary, inside leaf) ───────
  const edgeDistPx = bfsDist(W, H, i => fallAlpha[i] < 0.5);
  let maxEdgeDist = 0;
  for (let i = 0; i < W * H; i++) {
    if (fallAlpha[i] > 0.5 && edgeDistPx[i] < 1e8 && edgeDistPx[i] > maxEdgeDist) {
      maxEdgeDist = edgeDistPx[i];
    }
  }
  const edgeDist = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    edgeDist[i] = fallAlpha[i] > 0.5
      ? Math.min(edgeDistPx[i] / maxEdgeDist, 1)
      : 0;
  }

  // ── Noise ─────────────────────────────────────────────────────────────────
  const noise = smoothNoise(W, H, 60);

  // ── Transition delay mask ─────────────────────────────────────────────────
  // 0 = changes first (leaf edges, between-vein zones)
  // 1 = changes last  (veins, leaf interior centre)
  const delay = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (fallAlpha[i] < 0.5) { delay[i] = 0; continue; }
    delay[i] = edgeDist[i] * 0.35
             + veinProximity[i] * 0.45
             + noise[i] * 0.20;
  }

  // ── Erode fall alpha by ~1.5 px ──────────────────────────────────────────
  const erodedAlpha = erodeAlpha(fallAlpha, W, H, 1.5);

  // ── Dilate colours outward before blurring (avoids dark/white halos) ─────
  const sumDilatedPx = dilateColors(sumPx, W, H);
  const winDilatedPx = dilateColors(winPx, W, H);
  const falDilatedPx = dilateColors(falPx, W, H);
  const traDilatedPx = dilateColors(traPx, W, H);

  // Helper: Uint8ClampedArray → OffscreenCanvas → blurred OffscreenCanvas
  function toBlurred(pixels, blurPx) {
    const src = new OffscreenCanvas(W, H);
    src.getContext('2d').putImageData(new ImageData(pixels, W, H), 0, 0);
    return canvasBlur(src, blurPx);
  }

  const sumLFCanvas        = toBlurred(sumDilatedPx, 35);
  const winLFCanvas        = toBlurred(winDilatedPx, 35);
  const fallLFCanvas       = toBlurred(falDilatedPx, 35);
  const transitionLFCanvas = toBlurred(traDilatedPx, 35);

  // ── fallDetail: fall RGB with eroded alpha in channel A ──────────────────
  const fallDetailCtx = (() => {
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.drawImage(fallBmp, 0, 0, W, H);
    const id = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < W * H; i++) {
      id.data[i * 4 + 3] = Math.round(erodedAlpha[i] * 255);
    }
    ctx.putImageData(id, 0, 0);
    return c;
  })();

  // ── delay packed into R channel of an RGBA canvas ────────────────────────
  const delayCtx = (() => {
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d');
    const id  = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = Math.round(delay[i] * 255);
      id.data[i * 4]     = v;
      id.data[i * 4 + 1] = v;
      id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  })();

  return {
    fallDetail:   fallDetailCtx,      // RGBA — fall RGB + eroded silhouette
    summerLF:     sumLFCanvas,        // RGBA — summer     low-freq colour
    transitionLF: transitionLFCanvas, // RGBA — transition low-freq colour
    winterLF:     winLFCanvas,        // RGBA — winter     low-freq colour
    fallLF:       fallLFCanvas,       // RGBA — fall       low-freq colour (HF normalisation)
    delay:        delayCtx,           // RGBA (R=delay) — per-pixel transition delay
  };
}
