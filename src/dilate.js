/**
 * dilateTexture(imageBitmap, radius)
 * Pads edge colours outward by `radius` pixels into transparent areas.
 * Returns an HTMLCanvasElement usable as a PixiJS texture source.
 */
export function dilateTexture(imageBitmap, radius = 30) {
  const w = imageBitmap.width;
  const h = imageBitmap.height;

  // Draw source into offscreen canvas
  const src = new OffscreenCanvas(w, h);
  const sCtx = src.getContext('2d');
  sCtx.drawImage(imageBitmap, 0, 0);
  const srcData = sCtx.getImageData(0, 0, w, h).data;

  const dst = new OffscreenCanvas(w, h);
  const dCtx = dst.getContext('2d');
  dCtx.drawImage(imageBitmap, 0, 0);
  const dstData = dCtx.getImageData(0, 0, w, h);
  const out = dstData.data;

  // For each transparent pixel find nearest opaque pixel within radius and copy its RGB
  const r2 = radius * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (srcData[i + 3] > 10) continue; // already opaque-ish, skip

      let bestDist = r2 + 1;
      let br = 0, bg = 0, bb = 0, found = false;

      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);

      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const si = (sy * w + sx) * 4;
          if (srcData[si + 3] < 10) continue;
          const dx = sx - x, dy = sy - y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            br = srcData[si];
            bg = srcData[si + 1];
            bb = srcData[si + 2];
            found = true;
          }
        }
      }

      if (found) {
        out[i] = br; out[i + 1] = bg; out[i + 2] = bb;
        // Keep alpha = 0 so only the shader blend sees these padded colours;
        // we set alpha to 1 so PixiJS uploads them, but the shader masks with fall alpha.
        out[i + 3] = 1;
      }
    }
  }

  dCtx.putImageData(dstData, 0, 0);
  return dst; // OffscreenCanvas → Texture.from() accepts it
}
