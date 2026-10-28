// GLSL 300 es — PixiJS v8 / WebGL2

// ─── Vertex: subdivided mesh with seasonal curl warp ─────────────────────────
export const VERT = /* glsl */`#version 300 es
precision mediump float;

in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

uniform float uCurl;
uniform vec2  uPivot;
uniform float uAsymmetry;

out vec2 vUV;

void main() {
  vUV = aUV;

  vec2 fromPivot = aUV - uPivot;
  float dist     = length(fromPivot);

  // Only droop — no inward pull, no scale shrink, so the leaf stays the same size.
  // Slight asymmetry makes it feel organic rather than mechanical.
  float droop    = uCurl * dist * 0.14 * (1.0 + uAsymmetry * sign(fromPivot.x));

  vec2 warped    = aPosition;
  warped.y      += droop;

  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(warped, 1.0)).xy, 0.0, 1.0);
}
`;

// ─── Fragment: single leaf, colour-only transition with spatial sweep ─────────
export const FRAG = /* glsl */`#version 300 es
precision mediump float;

// ── Texture inputs ──────────────────────────────────────────────────────────
uniform sampler2D uFallDetail;      // fall image RGB  +  eroded silhouette in A
uniform sampler2D uSummerLF;        // summer     low-freq colour (blurred, dilated)
uniform sampler2D uTransitionLF;    // transition low-freq colour (blurred, dilated)
uniform sampler2D uWinterLF;        // winter     low-freq colour (blurred, dilated)
uniform sampler2D uFallLF;          // fall       low-freq colour (for HF normalisation)
uniform sampler2D uDelay;           // per-pixel transition delay [0,1] in R channel

// ── Scalar uniforms ─────────────────────────────────────────────────────────
uniform float uAngle;    // 0..1  (0 = summer, 0.25 = fall, 0.5 = winter)
uniform float uOverlay;  // 0/1  debug: show all three images at 50% opacity

in  vec2 vUV;
out vec4 outColor;

// ─── Spatial sweep helper ────────────────────────────────────────────────────
// delay [0,1]: 0 = pixel changes first (edges), 1 = changes last (veins)
// SPREAD controls how far ahead the front edge is relative to the back.
const float SPREAD = 0.50;

float localT(float globalT, float delay) {
  // Remap so pixels with delay=0 start at globalT=0,
  // pixels with delay=1 start at globalT=SPREAD.
  float start = delay * SPREAD;
  return smoothstep(start, start + (1.0 - SPREAD), globalT);
}

// ─── Luminance ───────────────────────────────────────────────────────────────
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  // ── Sample textures ────────────────────────────────────────────────────────
  vec4  fallRGBA  = texture(uFallDetail, vUV);
  float silhouette = fallRGBA.a;
  vec3  fallFull  = fallRGBA.rgb;

  vec3 sumLF  = texture(uSummerLF,     vUV).rgb;
  vec3 traLF  = texture(uTransitionLF, vUV).rgb;
  vec3 winLF  = texture(uWinterLF,     vUV).rgb;
  vec3 falLF  = texture(uFallLF,       vUV).rgb;
  float delay = texture(uDelay,        vUV).r;

  // ── High-frequency detail from fall luminance ratio ────────────────────────
  // hfRatio encodes all the vein/spot/texture micro-structure of the fall leaf.
  // Multiplying any colour by it gives that colour the fall leaf's detail.
  float fallLum   = luma(fallFull);
  float fallLFLum = max(luma(falLF), 0.04);
  float hfRatio   = clamp(fallLum / fallLFLum, 0.35, 2.5); // clamped to prevent dark-edge artifacts on bright seasons

  // Recolour each season using fall's detail map
  vec3 summerColored     = clamp(sumLF * hfRatio, 0.0, 1.3);
  vec3 transitionColored = clamp(traLF * hfRatio, 0.0, 1.3);
  vec3 winterColored     = clamp(winLF * hfRatio, 0.0, 1.3);
  vec3 fallColored       = fallFull;       // fall is the reference — use as-is

  // ── Select and blend by season angle with spatial delay ───────────────────
  vec3 finalColor;

  // Dial layout:
  //   0.00 (  0°, top)    = summer (green)
  //   0.25 ( 90°, right)  = transition (yellow-orange)
  //   0.50 (180°, bottom) = full fall  (orange-red)
  //   0.75 (270°, left)   = winter     (brown)
  //   1.00 (360°, top)    = back to summer

  if (uAngle < 0.25) {
    // Summer → Transition (top to right)
    float t = localT(uAngle / 0.25, delay);
    finalColor = mix(summerColored, transitionColored, t);

  } else if (uAngle < 0.5) {
    // Transition → Fall (right to bottom)
    float t = localT((uAngle - 0.25) / 0.25, delay);
    finalColor = mix(transitionColored, fallColored, t);

  } else if (uAngle < 0.75) {
    // Fall → Winter (bottom to left):  edges and tips first, veins last
    float t = localT((uAngle - 0.5) / 0.25, delay);
    finalColor = mix(fallColored, winterColored, t);

  } else {
    // Winter → Summer / spring (left back to top):  veins revive first
    float t = localT((uAngle - 0.75) / 0.25, 1.0 - delay);
    finalColor = mix(winterColored, summerColored, t);
  }

  // ── Debug overlay: 50% opacity composite of all three raw images ──────────
  if (uOverlay > 0.5) {
    vec4 sumRaw = texture(uSummerLF,     vUV);
    vec4 traRaw = texture(uTransitionLF, vUV);
    vec4 winRaw = texture(uWinterLF,     vUV);
    finalColor = finalColor * 0.4
               + sumRaw.rgb * 0.15
               + traRaw.rgb * 0.15
               + fallFull   * 0.15
               + winRaw.rgb * 0.15;
  }

  outColor = vec4(finalColor * silhouette, silhouette);
}
`;
