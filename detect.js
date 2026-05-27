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

export function detectWalls(img, opts = {}) {
  const natW = img.naturalWidth, natH = img.naturalHeight;
  if (!natW || !natH) return [];

  // 1. Rasterize at capped resolution.
  const scale = Math.min(1, MAX_DIM / Math.max(natW, natH));
  const W = Math.max(1, Math.round(natW * scale));
  const H = Math.max(1, Math.round(natH * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, W, H);
  let px;
  try { px = cx.getImageData(0, 0, W, H).data; }
  catch { return []; } // tainted (cross-origin) canvas

  // 2. Ink mask (1 = dark stroke).
  const gray = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
  }
  const thr = opts.threshold ?? otsu(gray);
  const ink = new Uint8Array(W * H);
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) { if (gray[i] < thr) { ink[i] = 1; inkCount++; } }
  if (inkCount === 0) return [];

  // 3. Distance-to-background (Chebyshev) over ink → wall half-thickness.
  const bgSeed = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) bgSeed[i] = ink[i] ? 0 : 1;
  const distToBg = chebyshev(W, H, bgSeed);
  const halfThick = Math.max(1, percentileOverInk(distToBg, ink, 0.90));

  // 4. Morphological open: erode by r (kill thin marks) then dilate by r.
  const r = Math.max(1, Math.round(halfThick * 0.6));
  const eroded = new Uint8Array(W * H);
  for (let i = 0; i < distToBg.length; i++) eroded[i] = distToBg[i] > r ? 1 : 0;
  const distToEroded = chebyshev(W, H, eroded); // seeds where eroded==1
  const opened = new Uint8Array(W * H);
  for (let i = 0; i < opened.length; i++) opened[i] = distToEroded[i] <= r ? 1 : 0;

  // 5. Extract bands. Lengths/thickness in working px.
  const minLen = Math.max(10, Math.round(Math.min(W, H) * 0.04));
  const maxBandThick = Math.max(3, Math.round(halfThick * 2 * 1.8));
  const segs = [
    ...extractBands(opened, W, H, 'h', minLen, maxBandThick),
    ...extractBands(opened, W, H, 'v', minLen, maxBandThick),
  ];

  // 6. Scale back to native px + snap corners (~one wall thickness tolerance).
  const inv = 1 / scale;
  const walls = segs.map(s => ({
    x1: s.x1 * inv, y1: s.y1 * inv, x2: s.x2 * inv, y2: s.y2 * inv,
  }));
  const snapTol = Math.max(3, Math.round(halfThick * 2 * inv));
  return snapCorners(walls, snapTol);
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
function extractBands(mask, W, H, dir, minLen, maxThick) {
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
      else closeBand(bnd, segs, dir, maxThick);
    }
    active = next;
  }
  for (const bnd of active) closeBand(bnd, segs, dir, maxThick);
  return segs;
}

function closeBand(b, segs, dir, maxThick) {
  if (b.bEnd - b.bStart + 1 > maxThick) return; // too fat to be a wall stroke
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
