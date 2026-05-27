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

export function detectWalls(img) {
  const prep = prepare(img);
  if (!prep) return [];
  const { W, H, scale, ink, halfThick } = prep;

  // Extract bands straight from the ink, gated by band THICKNESS: a wall is a
  // long run that is also several px thick. This rejects 1px dimension lines
  // (too thin) and short text strokes (too short) WITHOUT eroding — erosion was
  // wiping out genuinely thin walls. Lengths/thickness in working px.
  const minLen = Math.max(10, Math.round(Math.min(W, H) * 0.04));
  const minThick = Math.max(2, Math.round(halfThick));
  const maxBandThick = Math.max(minThick + 2, Math.round(halfThick * 2 * 2.2));
  const segs = [
    ...extractBands(ink, W, H, 'h', minLen, minThick, maxBandThick),
    ...extractBands(ink, W, H, 'v', minLen, minThick, maxBandThick),
  ];

  // Scale back to native px + snap corners (~one wall thickness tolerance).
  const inv = 1 / scale;
  const walls = segs.map(s => ({
    x1: s.x1 * inv, y1: s.y1 * inv, x2: s.x2 * inv, y2: s.y2 * inv,
  }));
  const snapTol = Math.max(3, Math.round(halfThick * 2 * inv));
  return snapCorners(walls, snapTol);
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
