// detect.js — dependency-free wall detection for solid-wall, axis-aligned floor
// plans. Returns walls in NATIVE image pixels: [{ x1, y1, x2, y2 }].
//
// Pipeline:
//   1. Rasterize the image (capped resolution for speed).
//   2. Threshold to an "ink" mask (Otsu).
//   3. Distance-transform the ink → estimate wall half-thickness.
//   4. Morphological OPEN at a radius below half-thickness: thin marks (text,
//      dimension lines, furniture hairlines, double-line walls) erode away;
//      thick wall strokes survive. This is what separates walls from noise.
//   5. Extract horizontal & vertical wall BANDS by run-length, collapse each to
//      a centerline segment, filter by length and band thickness.
//   6. Snap shared coordinates so corners meet; drop degenerate segments.
//
// Plans whose walls are thin double-lines (no solid stroke) yield few or no
// walls BY DESIGN — the caller falls back to manual tracing.

const MAX_DIM = 1000; // working-resolution cap; coords scale back to native px

// Diagnostics for the in-app debug overlay (view2d reads this when
// `state.debugDetect` is on). Populated by the ML detectors in NATIVE image px so
// the 2D canvas can draw the raw model output + every placement decision on top of
// the plan. Null until a detector has run.
//   dw   — { records:[{type,conf, bx1,by1,bx2,by2 (raw box), decision, placeX,placeY
//            (attach point) | bx1..by2 bridge seg, wallDist, tol}], natW, natH }
export const detectDebug = { dw: null };

// Rasterize + threshold the image and build the masks both detectors share:
//   ink     — every dark stroke
//   opened  — only the THICK strokes (walls), thin marks eroded away
//   halfThick — estimated wall half-thickness (working px)
// Returns null on a blank/tainted image.
function prepare(img) {
  const natW = img.naturalWidth, natH = img.naturalHeight;
  if (!natW || !natH) return null;
  const scale = Math.min(1, MAX_DIM / Math.max(natW, natH));
  const W = Math.max(1, Math.round(natW * scale));
  const H = Math.max(1, Math.round(natH * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, W, H);
  let px;
  try { px = cx.getImageData(0, 0, W, H).data; }
  catch { return null; } // tainted (cross-origin) canvas

  const gray = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
  }
  const thr = otsu(gray);
  const ink = new Uint8Array(W * H);
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) { if (gray[i] < thr) { ink[i] = 1; inkCount++; } }
  if (inkCount === 0) return null;

  // Distance-to-background over ink → wall half-thickness.
  const bgSeed = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) bgSeed[i] = ink[i] ? 0 : 1;
  const distToBg = chebyshev(W, H, bgSeed);
  const halfThick = Math.max(1, percentileOverInk(distToBg, ink, 0.90));

  // Morphological open: erode by r (kill thin marks) then dilate by r.
  const r = Math.max(1, Math.round(halfThick * 0.6));
  const eroded = new Uint8Array(W * H);
  for (let i = 0; i < distToBg.length; i++) eroded[i] = distToBg[i] > r ? 1 : 0;
  const distToEroded = chebyshev(W, H, eroded);
  const opened = new Uint8Array(W * H);
  for (let i = 0; i < opened.length; i++) opened[i] = distToEroded[i] <= r ? 1 : 0;

  return { W, H, scale, ink, opened, halfThick, gray, thr };
}

// Shared tail for BOTH detectors: a binary wall mask at working resolution (W×H)
// + its scale back to native px + estimated half-thickness → wall centerlines in
// native pixels. The Otsu heuristic and the ML model differ ONLY in how they
// produce `ink`; everything below (band extraction, corner snapping) is identical.
function wallsFromMask(ink, W, H, scale, halfThick) {
  const minLen = Math.max(10, Math.round(Math.min(W, H) * 0.04));
  const minThick = Math.max(2, Math.round(halfThick));
  const maxBandThick = Math.max(minThick + 2, Math.round(halfThick * 2 * 2.2));
  const segs = [
    ...extractBands(ink, W, H, 'h', minLen, minThick, maxBandThick),
    ...extractBands(ink, W, H, 'v', minLen, minThick, maxBandThick),
  ];
  const inv = 1 / scale;
  const walls = segs.map(s => ({
    x1: s.x1 * inv, y1: s.y1 * inv, x2: s.x2 * inv, y2: s.y2 * inv,
  }));
  const snapTol = Math.max(3, Math.round(halfThick * 2 * inv));
  return snapCorners(walls, snapTol);
}

// Estimate wall half-thickness from a binary mask (same approach prepare() uses).
function halfThickOf(ink, W, H) {
  const bgSeed = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) bgSeed[i] = ink[i] ? 0 : 1;
  const distToBg = chebyshev(W, H, bgSeed);
  return Math.max(1, percentileOverInk(distToBg, ink, 0.90));
}

export function detectWalls(img) {
  const prep = prepare(img);
  if (!prep) return [];
  // Otsu ink → the proven band/snap tail. Gated by band thickness so 1px
  // dimension lines and short text strokes don't register as walls.
  return wallsFromMask(prep.ink, prep.W, prep.H, prep.scale, prep.halfThick);
}

// --- ML wall detection (on-device). Lazy-loads the vendored ONNX runtime + model
// only when first invoked (mirrors pdf.js); the heuristic above stays dependency-free
// and is the guaranteed fallback. Output shape is identical to detectWalls():
// [{ x1, y1, x2, y2 }] in native pixels, so callers/state are unchanged.
const ML_MODEL_URL = '/models/walls-v1.onnx';
const ML_SIZE = 512; // must match the wall model's training input size (v1 trained at 512).
                     // Reverted v2 (640): higher recall but lower precision → phantom walls.
const ML_MEAN = [0.485, 0.456, 0.406], ML_STD = [0.229, 0.224, 0.225];
let _ort = null, _wallSession = null;

async function getOrt() {
  if (_ort) return _ort;
  _ort = await import('./vendor/ort/ort.wasm.min.mjs');
  _ort.env.wasm.wasmPaths = '/vendor/ort/';
  _ort.env.wasm.numThreads = 1;        // single-thread: no SharedArrayBuffer/COOP-COEP
  return _ort;
}
async function getWallSession() {
  if (_wallSession) return _wallSession;
  const ort = await getOrt();
  _wallSession = await ort.InferenceSession.create(ML_MODEL_URL, { executionProviders: ['wasm'] });
  return _wallSession;
}

// Door/window detector (YOLOv8n, 2-class). Lazy-loaded like the wall model.
const DW_MODEL_URL = '/models/doors-v2.onnx';
const DW_SIZE = 640; // YOLOv8n @ 640. (doors-v3 = YOLOv8s@800 scored higher on val but
                     // generalized WORSE to real plans — missed closet doors — so reverted.)
const DW_CONF_DOOR = 0.25;            // door confidence floor (low — catch faint interior doors)
const DW_CONF_WINDOW = 0.40;          // windows over-fire on wall/dimension lines → demand more confidence
const DW_CLASSES = ['door', 'window'];
// Reject impossibly-large detections (the main clutter source — long wall double-
// lines / dimension lines misread as windows). Absolute (ft) AND scale-free
// (fraction of the plan) caps, so it holds regardless of calibration.
const DW_MAX_FT = { door: 8, window: 9 };
const DW_MAX_SPAN_FRAC = 0.35;
const DW_DEBUG = false;               // flip to true to log each detection's placement decision to the console
let _dwSession = null;

async function getDwSession() {
  if (_dwSession) return _dwSession;
  const ort = await getOrt();
  _dwSession = await ort.InferenceSession.create(DW_MODEL_URL, { executionProviders: ['wasm'] });
  return _dwSession;
}

export async function detectWallsML(img) {
  const natW = img.naturalWidth, natH = img.naturalHeight;
  if (!natW || !natH) return [];
  const ort = await getOrt();
  const sess = await getWallSession();

  // Preprocess exactly like training: stretch to 512×512, ImageNet-normalize, CHW.
  const S = ML_SIZE;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, S, S);
  let px;
  try { px = cx.getImageData(0, 0, S, S).data; } catch { return []; } // tainted canvas
  const t = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    t[i]            = (px[i * 4]     / 255 - ML_MEAN[0]) / ML_STD[0];
    t[S * S + i]    = (px[i * 4 + 1] / 255 - ML_MEAN[1]) / ML_STD[1];
    t[2 * S * S + i] = (px[i * 4 + 2] / 255 - ML_MEAN[2]) / ML_STD[2];
  }
  const out = await sess.run({ input: new ort.Tensor('float32', t, [1, 3, S, S]) });
  const lg = out.logits.data;  // [1,2,S,S]: bg = [0 .. S*S), wall = [S*S .. 2*S*S)

  // argmax per pixel → 512² wall mask.
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = lg[S * S + i] > lg[i] ? 1 : 0;

  // Resample the (stretched) 512² mask onto the aspect-correct working grid W×H,
  // matching prepare()'s convention so wallsFromMask scales back to native px right.
  const scale = Math.min(1, MAX_DIM / Math.max(natW, natH));
  const W = Math.max(1, Math.round(natW * scale)), H = Math.max(1, Math.round(natH * scale));
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(S - 1, (y * S / H) | 0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(S - 1, (x * S / W) | 0);
      ink[y * W + x] = m[sy * S + sx];
    }
  }
  return wallsFromMask(ink, W, H, scale, halfThickOf(ink, W, H));
}

// --- ML door/window detection (on-device). Runs the YOLO detector, then SNAPS
// each box at the location the MODEL found it. If a same-orientation wall is
// right there, the opening attaches to it (wallId + t + width) so 3D segments a
// real hole; otherwise it's placed as a short bridge at the box (matching the
// spike — the model's position is trusted). `walls` is OPTIONAL: with none, every
// detection is placed as a bridge, so this works standalone.
// Returns items: { type, wallId, t, widthFt } (attached) or { type, bridge, x1,y1,x2,y2, widthFt }.
export async function detectDoorsWindowsML(img, walls = [], opts = {}) {
  detectDebug.dw = null; // clear last run's overlay data up front
  const natW = img.naturalWidth, natH = img.naturalHeight;
  if (!natW || !natH) return [];
  const pxPerFt = opts.pxPerFt || 12;
  const ort = await getOrt();
  const sess = await getDwSession();

  // Letterbox to 640 (preserve aspect, gray pad) — matches YOLO training preprocessing.
  const S = DW_SIZE;
  const sc = S / Math.max(natW, natH);
  const nw = Math.round(natW * sc), nh = Math.round(natH * sc);
  const padX = Math.floor((S - nw) / 2), padY = Math.floor((S - nh) / 2);
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = 'rgb(114,114,114)'; cx.fillRect(0, 0, S, S);
  cx.drawImage(img, padX, padY, nw, nh);
  let px;
  try { px = cx.getImageData(0, 0, S, S).data; } catch { return []; } // tainted canvas
  const t = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    t[i] = px[i * 4] / 255; t[S * S + i] = px[i * 4 + 1] / 255; t[2 * S * S + i] = px[i * 4 + 2] / 255;
  }
  const out = await sess.run({ images: new ort.Tensor('float32', t, [1, 3, S, S]) });
  const d = out.output0.data; // [1,300,6] = x1,y1,x2,y2,conf,cls in letterboxed 640 space

  // Parse boxes above a PER-CLASS threshold → native px (undo the letterbox).
  const boxes = [];
  for (let i = 0; i < 300; i++) {
    const conf = d[i * 6 + 4];
    const type = DW_CLASSES[d[i * 6 + 5] | 0] || 'door';
    if (conf < (type === 'window' ? DW_CONF_WINDOW : DW_CONF_DOOR)) continue;
    boxes.push({
      x1: (d[i * 6]     - padX) / sc, y1: (d[i * 6 + 1] - padY) / sc,
      x2: (d[i * 6 + 2] - padX) / sc, y2: (d[i * 6 + 3] - padY) / sc,
      conf, type,
    });
  }
  if (!boxes.length) return [];

  // Place each detected box. If it sits on a detected wall, attach the opening to
  // that wall AT ITS TRUE PROJECTED POSITION (no inward shove — that was pushing
  // doors sideways on short interior walls). If no wall is close enough but one is
  // nearby, drop a short "bridge" at the box's own location so the opening still
  // lands where the model found it (interior doors whose host wall wasn't detected).
  // Boxes far from every wall are treated as false positives and dropped.
  const minDim = Math.min(natW, natH);
  const cand = [];
  const dbg = [];
  for (const b of boxes) {
    const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
    const bcx = (b.x1 + b.x2) / 2, bcy = (b.y1 + b.y2) / 2;
    const boxHoriz = bw >= bh; // wide box ⇒ opening runs horizontally ⇒ horizontal wall
    // Nearest wall OF MATCHING ORIENTATION (a vertical door belongs on a vertical
    // wall, not whatever edge is merely closest) plus nearest wall of any
    // orientation (used only to gate bridging so we don't strand doors in open space).
    let best = null, bestD = Infinity, anyD = Infinity;
    for (const w of walls) {
      const p = projectToSeg(bcx, bcy, w);
      if (p.dist < anyD) anyD = p.dist;
      const wallHoriz = Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1);
      if (wallHoriz !== boxHoriz) continue; // orientation mismatch — skip
      if (p.dist < bestD) { bestD = p.dist; best = { w, u: p.u }; }
    }
    const tol = Math.max(0.5 * Math.min(bw, bh) + 8, 0.03 * minDim);
    const rec = { type: b.type, conf: +b.conf.toFixed(2), cx: Math.round(bcx), cy: Math.round(bcy),
                  box: `${bw | 0}x${bh | 0}`, wallDist: Math.round(bestD), anyDist: Math.round(anyD),
                  tol: Math.round(tol), decision: '',
                  // raw model box (native px) for the debug overlay
                  bx1: b.x1, by1: b.y1, bx2: b.x2, by2: b.y2 };
    if (best && bestD <= tol) {
      const w = best.w;
      const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
      const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
      // Opening width = the box's extent ALONG the wall direction.
      let lo = Infinity, hi = -Infinity;
      for (const [cxp, cyp] of [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]) {
        const proj = (cxp - w.x1) * ux + (cyp - w.y1) * uy;
        lo = Math.min(lo, proj); hi = Math.max(hi, proj);
      }
      const spanPx = Math.min(Math.max(6, hi - lo), L);
      const ft = cleanWidthFt(b.type, spanPx, minDim, pxPerFt);
      if (ft == null) { rec.decision = 'DROP (oversized)'; dbg.push(rec); continue; }
      const px = w.x1 + best.u * (w.x2 - w.x1), py = w.y1 + best.u * (w.y2 - w.y1);
      cand.push({ type: b.type, conf: b.conf, wallId: w.id, t: best.u, widthFt: ft, cx: px, cy: py });
      rec.decision = 'attach'; rec.placeX = px; rec.placeY = py; // box → this point on the wall
    } else {
      // No matching wall to sit on → place at the detected location (like the
      // spike), oriented by box shape (wide ⇒ horizontal opening, tall ⇒ vertical).
      const ft = cleanWidthFt(b.type, boxHoriz ? bw : bh, minDim, pxPerFt);
      if (ft == null) { rec.decision = 'DROP (oversized)'; dbg.push(rec); continue; }
      const half = (ft * pxPerFt) / 2; // bridge length matches the cleaned width
      const seg = boxHoriz ? { x1: bcx - half, y1: bcy, x2: bcx + half, y2: bcy }
                           : { x1: bcx, y1: bcy - half, x2: bcx, y2: bcy + half };
      cand.push({ type: b.type, conf: b.conf, bridge: true, ...seg, widthFt: ft, cx: bcx, cy: bcy });
      rec.decision = 'bridge'; rec.seg = seg; // floating opening dropped at this span
    }
    dbg.push(rec);
  }
  detectDebug.dw = { records: dbg, natW, natH }; // for the in-app debug overlay
  if (DW_DEBUG && typeof console !== 'undefined') {
    const lines = dbg.map(r =>
      `${r.type}\tconf=${r.conf}\t(${r.cx},${r.cy})\tbox=${r.box}\twallDist=${r.wallDist}\tanyDist=${r.anyDist}\ttol=${r.tol}\t→ ${r.decision}`);
    console.log(`[DW] ${boxes.length} detections (door≥${DW_CONF_DOOR}, window≥${DW_CONF_WINDOW}), ${walls.length} walls, img ${natW}x${natH}\n` + lines.join('\n'));
  }

  // De-dup only NEAR-COINCIDENT detections (higher confidence wins) — collapses
  // cross-class/stacked boxes on the SAME opening (e.g. the top-wall door+window
  // stack) without swallowing two genuinely separate doorways that sit close by.
  cand.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const it of cand) {
    const r = Math.max(6, it.widthFt * pxPerFt * 0.3);
    if (kept.some(k => Math.hypot(k.cx - it.cx, k.cy - it.cy) < r)) continue;
    kept.push(it);
  }
  if (DW_DEBUG && typeof console !== 'undefined') {
    const dN = kept.filter(k => k.type === 'door').length;
    console.log(`[DW] placed ${kept.length} after de-dup (${dN} door, ${kept.length - dN} window)`);
  }
  return kept.map(({ cx, cy, conf, ...rest }) => rest);
}

// Clean an opening's width: reject impossibly-large detections (false windows on
// wall/dimension lines) via an absolute ft cap AND a scale-free fraction-of-plan
// cap, and standardize typical single doors to ~3 ft. Returns width in ft, or null
// to drop the detection.
function cleanWidthFt(type, spanPx, minDim, pxPerFt) {
  if (spanPx > DW_MAX_SPAN_FRAC * minDim) return null;      // too big for any real opening (scale-free)
  let ft = spanPx / pxPerFt;
  if (ft > (DW_MAX_FT[type] || 8)) return null;             // absolute cap
  if (type === 'door' && ft < 4) ft = 3;                    // single doors are ~3 ft (drops swing-arc inflation)
  return ft;
}

// Closest point on segment w to (px,py): returns param u∈[0,1] along the segment
// and the perpendicular distance to it.
function projectToSeg(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const L2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / L2));
  const qx = w.x1 + u * dx, qy = w.y1 + u * dy;
  return { u, dist: Math.hypot(px - qx, py - qy) };
}

// Detect doors & windows from the GAPS between detected/traced walls. The gaps
// give us location for free; what fills each gap is decided scale-free:
//   • a gap with thin GLASS MARKS in it      ⇒ window
//   • a narrow EMPTY gap (door-ish width)    ⇒ door
//   • a wide EMPTY gap                        ⇒ open passage (left alone)
// Placement always fills the gap (opening width = gap), so an exact px/ft isn't
// needed — pxPerFt only labels the stored width. `walls` are native-px segments.
// Returns [{ kind:'bridge', x1,y1,x2,y2, type, widthFt }].
const GLASS_MIN = 0.7;       // light-ink runs across the opening …
const DARK_MAX = 0.3;        // … with little wall-dark ink ⇒ glass (window), not a slab/wall
const WALL_FULL = 0.85;      // dark ink spans the whole gap ⇒ a wall the detector missed, not an opening
const DOOR_MAX_FACTOR = 1.8; // empty gaps up to this × the typical narrow gap are doors

export function detectOpenings(img, walls, opts = {}) {
  if (!walls || walls.length < 2) return [];
  const prep = prepare(img);
  if (!prep) return [];
  const { W, H, scale, ink, halfThick, gray, thr } = prep;
  const pxPerFt = opts.pxPerFt || 12;

  // Window glass is usually drawn LIGHTER than walls, so the wall-level threshold
  // drops it. A more sensitive "light ink" mask reveals the glass / sill lines —
  // this is the difference between catching a window and mistaking it for a door.
  const lightThr = Math.min(235, thr + 70);
  const lightInk = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) lightInk[i] = gray[i] < lightThr ? 1 : 0;

  const natMin = Math.min(W, H) / scale;
  const gaps = enumerateGaps(walls, {
    minGapPx: Math.max(4, (halfThick / scale) * 2.5),
    maxGapPx: natMin * 0.4,
    offsetPx: Math.max(4, (halfThick / scale) * 2.5),
  });
  if (!gaps.length) return [];

  // Typical door ≈ the narrow end of the gap-width distribution (scale-free).
  const widths = gaps.map(g => g.lenPx).sort((a, b) => a - b);
  const lower = widths.slice(0, Math.max(1, Math.ceil(widths.length * 0.6)));
  const doorMaxPx = lower[lower.length >> 1] * DOOR_MAX_FACTOR;

  // Per gap: glass running continuously across the opening (on the wall line) ⇒
  // window; otherwise a narrow gap ⇒ door; a wide empty gap ⇒ open passage.
  const out = [];
  for (const g of gaps) {
    const darkLine = glassContinuity(g, ink, scale, halfThick, W, H);
    if (darkLine >= WALL_FULL) continue; // solid wall the detector missed — not an opening
    const lightLine = glassContinuity(g, lightInk, scale, halfThick, W, H);
    let type = null;
    if (lightLine >= GLASS_MIN && darkLine <= DARK_MAX) type = 'window'; // light glass, no dark slab
    else if (g.lenPx <= doorMaxPx) type = 'door';
    if (!type) continue; // wide empty gap / dark slab that isn't door-width → leave open
    out.push({ kind: 'bridge', x1: g.p1.x, y1: g.p1.y, x2: g.p2.x, y2: g.p2.y, type, widthFt: g.lenPx / pxPerFt });
  }
  return out;
}

function sampleMask(mask, W, H, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return 0;
  return mask[yi * W + xi];
}

// Fraction of the opening's span that has ink sitting right on the wall line:
// a window's glass runs the whole way across (→1), an empty doorway is bare (→0).
function glassContinuity(gap, mask, scale, halfThick, W, H) {
  const ax = gap.p1.x * scale, ay = gap.p1.y * scale;
  const bx = gap.p2.x * scale, by = gap.p2.y * scale;
  const L = Math.hypot(bx - ax, by - ay);
  if (L < 2) return 0;
  const nx = -(by - ay) / L, ny = (bx - ax) / L;
  const band = Math.max(1.5, halfThick * 1.2);
  const steps = Math.max(6, Math.round(L));
  let on = 0, tot = 0;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (t < 0.1 || t > 0.9) continue; // skip the very ends (near the jambs)
    const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t;
    let hit = 0;
    for (let o = -band; o <= band; o += 1) if (sampleMask(mask, W, H, cx + nx * o, cy + ny * o)) { hit = 1; break; }
    on += hit; tot++;
  }
  return tot ? on / tot : 0;
}

// Pairs of wall endpoints (from different walls) that are collinear and a short
// distance apart — i.e. an un-traced opening. De-duped so one opening isn't
// reported by several endpoint pairings.
function enumerateGaps(walls, { minGapPx, maxGapPx, offsetPx }) {
  const ends = [];
  for (const w of walls) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy) || 1;
    ends.push({ x: w.x1, y: w.y1, ux: dx / len, uy: dy / len, wall: w });
    ends.push({ x: w.x2, y: w.y2, ux: dx / len, uy: dy / len, wall: w });
  }
  const gaps = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.wall === b.wall) continue;
      const g = Math.hypot(b.x - a.x, b.y - a.y);
      if (g < minGapPx || g > maxGapPx) continue;
      // The two wall ends must be nearly COLLINEAR — i.e. each lies close to the
      // other wall's line (small lateral offset). This is the defining trait of a
      // real opening gap, and it rejects diagonal bridges across open rooms
      // (walls offset by far more than a wall thickness).
      const perpA = Math.abs((b.x - a.x) * -a.uy + (b.y - a.y) * a.ux);
      const perpB = Math.abs((a.x - b.x) * -b.uy + (a.y - b.y) * b.ux);
      if (perpA > offsetPx || perpB > offsetPx) continue;
      gaps.push({ p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y }, lenPx: g });
    }
  }
  gaps.sort((p, q) => p.lenPx - q.lenPx);
  const kept = [];
  for (const gp of gaps) {
    const mx = (gp.p1.x + gp.p2.x) / 2, my = (gp.p1.y + gp.p2.y) / 2;
    const dup = kept.some(k => {
      const kx = (k.p1.x + k.p2.x) / 2, ky = (k.p1.y + k.p2.y) / 2;
      return Math.hypot(kx - mx, ky - my) < gp.lenPx * 0.6;
    });
    if (!dup) kept.push(gp);
  }
  return kept;
}

// --- Otsu threshold over a 0..255 grayscale histogram, clamped to a sane band.
function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return Math.max(60, Math.min(205, thr));
}

// --- Chebyshev (chessboard) distance transform: distance from each cell to the
// nearest SEED cell (seed[i]===1 ⇒ distance 0). Two-pass, O(W·H).
function chebyshev(W, H, seed) {
  const INF = 1 << 28;
  const d = new Int32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) m = Math.min(m, d[i - W] + 1);
      if (y > 0 && x > 0) m = Math.min(m, d[i - W - 1] + 1);
      if (y > 0 && x < W - 1) m = Math.min(m, d[i - W + 1] + 1);
      d[i] = m;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < W - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < H - 1) m = Math.min(m, d[i + W] + 1);
      if (y < H - 1 && x < W - 1) m = Math.min(m, d[i + W + 1] + 1);
      if (y < H - 1 && x > 0) m = Math.min(m, d[i + W - 1] + 1);
      d[i] = m;
    }
  }
  return d;
}

function percentileOverInk(dist, ink, p) {
  const vals = [];
  for (let i = 0; i < dist.length; i++) if (ink[i]) vals.push(dist[i]);
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
}

// --- Extract axis-aligned wall bands from a binary mask. For dir==='h' we scan
// row by row for long horizontal runs and stack vertically-overlapping runs into
// a band (the band's row-count ≈ the wall thickness); collapse each band to a
// centerline. dir==='v' is the transpose. A wall of the OTHER orientation is too
// short per-line to clear minLen, so each pass only catches its own walls.
function extractBands(mask, W, H, dir, minLen, minThick, maxThick) {
  const along = dir === 'h' ? W : H;   // axis the wall runs along
  const across = dir === 'h' ? H : W;  // axis we stack across
  const at = dir === 'h'
    ? (a, b) => mask[b * W + a]
    : (a, b) => mask[a * W + b];

  const segs = [];
  let active = [];
  for (let b = 0; b < across; b++) {
    // Long runs on this line.
    const runs = [];
    let s = -1;
    for (let a = 0; a < along; a++) {
      const on = at(a, b);
      if (on && s < 0) s = a;
      else if (!on && s >= 0) { if (a - s >= minLen) runs.push([s, a - 1]); s = -1; }
    }
    if (s >= 0 && along - s >= minLen) runs.push([s, along - 1]);

    const matched = new Set();
    const fresh = [];
    for (const [rs, re] of runs) {
      let band = null;
      for (const bnd of active) {
        if (!matched.has(bnd) && rs <= bnd.amax && re >= bnd.amin) { band = bnd; break; }
      }
      if (band) {
        band.amin = Math.min(band.amin, rs);
        band.amax = Math.max(band.amax, re);
        band.bEnd = b;
        matched.add(band);
      } else {
        fresh.push({ amin: rs, amax: re, bStart: b, bEnd: b });
      }
    }
    const next = fresh;
    for (const bnd of active) {
      if (matched.has(bnd)) next.push(bnd);
      else closeBand(bnd, segs, dir, minThick, maxThick);
    }
    active = next;
  }
  for (const bnd of active) closeBand(bnd, segs, dir, minThick, maxThick);
  return segs;
}

function closeBand(b, segs, dir, minThick, maxThick) {
  const thick = b.bEnd - b.bStart + 1;
  if (thick < minThick || thick > maxThick) return; // not a wall-thickness stroke
  const center = (b.bStart + b.bEnd) / 2;
  if (dir === 'h') segs.push({ x1: b.amin, y1: center, x2: b.amax, y2: center });
  else segs.push({ x1: center, y1: b.amin, x2: center, y2: b.amax });
}

// --- Snap near-equal endpoint coordinates together so axis-aligned walls share
// corner x/y values and meet cleanly. Drops segments shorter than the tolerance.
function snapCorners(walls, tol) {
  const xs = [], ys = [];
  for (const w of walls) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
  const sx = clusterMap(xs, tol), sy = clusterMap(ys, tol);
  for (const w of walls) {
    w.x1 = sx.get(w.x1); w.x2 = sx.get(w.x2);
    w.y1 = sy.get(w.y1); w.y2 = sy.get(w.y2);
  }
  return walls.filter(w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > tol);
}

function clusterMap(vals, tol) {
  const sorted = [...new Set(vals)].sort((a, b) => a - b);
  const map = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    const group = [sorted[i]];
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] <= tol) { j++; group.push(sorted[j]); }
    const mean = Math.round(group.reduce((a, b) => a + b, 0) / group.length);
    for (const v of group) map.set(v, mean);
    i = j + 1;
  }
  return map;
}
