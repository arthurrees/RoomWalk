// Geometry helpers operating in world (image) pixel coordinates.

export function dist(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return Math.hypot(dx, dy);
}

export function wallLengthPx(w) { return dist(w.x1, w.y1, w.x2, w.y2); }

// Project point (px,py) onto segment, returns { t, x, y, dist }.
// t is clamped to [0,1].
export function projectPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, x: ax, y: ay, dist: dist(px, py, ax, ay) };
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { t, x, y, dist: dist(px, py, x, y) };
}

// Find the closest wall to (px,py); returns { wall, t, x, y, dist } or null.
export function nearestWall(walls, px, py, maxDist = Infinity) {
  let best = null;
  for (const w of walls) {
    const p = projectPointToSegment(px, py, w.x1, w.y1, w.x2, w.y2);
    if (p.dist < (best?.dist ?? Infinity) && p.dist <= maxDist) {
      best = { wall: w, ...p };
    }
  }
  return best;
}

// Endpoint snap: find a wall endpoint within snapDist of (px,py).
export function snapToEndpoint(walls, px, py, snapDist) {
  let best = null;
  for (const w of walls) {
    for (const [ex, ey] of [[w.x1, w.y1], [w.x2, w.y2]]) {
      const d = dist(px, py, ex, ey);
      if (d <= snapDist && (best === null || d < best.dist)) {
        best = { x: ex, y: ey, dist: d };
      }
    }
  }
  return best;
}

// Detect a "gap" the cursor is hovering between two nearly-collinear wall
// endpoints — the un-traced doorway/window opening a user left open. The two
// endpoints become a short bridge wall that the opening then fills.
// Returns { p1, p2, mid, lenPx } or null. All distances in image pixels;
// callers pass screen tolerances pre-divided by zoom and spans in px (ft*scale).
export function findGap(walls, px, py, opts = {}) {
  const {
    maxGapPx = Infinity, // longest bridgeable gap (a doorway is "relatively short")
    minGapPx = 0,        // ignore endpoints already joined at a corner
    hitPx = 24,          // how close the cursor must be to the bridge line
    angleTolDeg = 18,    // max deviation from collinear for BOTH walls
  } = opts;

  const ends = [];
  for (const w of walls) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // wall's own unit direction
    ends.push({ x: w.x1, y: w.y1, ux, uy, wall: w });
    ends.push({ x: w.x2, y: w.y2, ux, uy, wall: w });
  }

  const cosTol = Math.cos(angleTolDeg * Math.PI / 180);
  let best = null;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.wall === b.wall) continue;
      const gap = dist(a.x, a.y, b.x, b.y);
      if (gap <= minGapPx || gap > maxGapPx) continue;
      // Bridge must continue both wall lines (reject perpendicular corners).
      const bx = (b.x - a.x) / gap, by = (b.y - a.y) / gap;
      if (Math.abs(a.ux * bx + a.uy * by) < cosTol) continue;
      if (Math.abs(b.ux * bx + b.uy * by) < cosTol) continue;
      // Cursor must sit on the bridge, between (not past) the endpoints.
      const proj = projectPointToSegment(px, py, a.x, a.y, b.x, b.y);
      if (proj.dist > hitPx || proj.t <= 0.001 || proj.t >= 0.999) continue;
      const score = proj.dist + gap * 0.05; // closest first, then smallest gap
      if (!best || score < best.score) {
        best = { p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y }, lenPx: gap, score };
      }
    }
  }
  if (best) {
    best.mid = { x: (best.p1.x + best.p2.x) / 2, y: (best.p1.y + best.p2.y) / 2 };
    delete best.score;
  }
  return best;
}

// Snap to axis (horizontal/vertical) relative to anchor (ax,ay) if within tolerance angle.
export function snapToAxis(ax, ay, px, py, tolDeg = 6) {
  const dx = px - ax, dy = py - ay;
  if (dx === 0 && dy === 0) return { x: px, y: py };
  const ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
  const tol = tolDeg;
  // horizontal
  if (Math.abs(ang) <= tol || Math.abs(Math.abs(ang) - 180) <= tol) {
    return { x: px, y: ay };
  }
  // vertical
  if (Math.abs(Math.abs(ang) - 90) <= tol) {
    return { x: ax, y: py };
  }
  return { x: px, y: py };
}

// Get bounding box of all walls.
export function wallsBoundingBox(walls) {
  if (walls.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Convert a (t, offsetPx) along a wall to absolute pixel coords.
// offsetPx is perpendicular displacement (positive = +normal).
export function pointOnWall(wall, t, offset = 0) {
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  return {
    x: wall.x1 + ux * t * len + nx * offset,
    y: wall.y1 + uy * t * len + ny * offset,
  };
}

export function wallAngle(wall) {
  return Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
}

// Pixels-per-foot used when the plan has not been calibrated yet. Shared by
// the 2D and 3D views so an opening occupies the same fraction of a wall in
// both — otherwise openings render at different relative sizes across views.
export const PX_PER_FT_FALLBACK = 12;

// --- Units (internal canonical length is FEET) ---
export const FT_PER_M = 3.280839895;

// Format a length given in feet for display in the chosen unit system.
export function formatLength(ft, units = 'imperial') {
  if (units === 'metric') {
    const m = ft / FT_PER_M;
    return m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`;
  }
  const totalIn = Math.round(ft * 12);
  const f = Math.floor(totalIn / 12), inch = totalIn % 12;
  if (f <= 0) return `${totalIn}"`;
  return inch ? `${f}'${inch}"` : `${f}'`;
}

// Format an area given in square feet.
export function formatArea(sqft, units = 'imperial') {
  if (units === 'metric') return `${(sqft / (FT_PER_M * FT_PER_M)).toFixed(1)} m²`;
  return `${Math.round(sqft)} sq ft`;
}

// Parse a user length string into FEET, honoring the unit system.
export function parseLength(raw, units = 'imperial') {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (units === 'metric') {
    let m = s.match(/^([\d.]+)\s*(?:mm)$/);            if (m) return num(m[1]) / 1000 * FT_PER_M;
    m = s.match(/^([\d.]+)\s*(?:cm|centimeters?)$/);   if (m) return num(m[1]) / 100 * FT_PER_M;
    m = s.match(/^([\d.]+)\s*(?:m|meters?|metres?)?$/); if (m) return num(m[1]) * FT_PER_M;
    return null;
  }
  // imperial: 36", 36in, 24'-6", 24' 6", 12'6, 3' 0 1/16", or plain feet
  let m = s.match(/^([\d.]+)\s*(?:"|in|inch|inches)$/);
  if (m) { const v = num(m[1]); return v > 0 ? v / 12 : null; }
  m = s.match(/^([\d.]+)\s*(?:'|ft|feet|f)\s*[-\s]?\s*([\d.]+)?(?:\s+(\d+)\/(\d+))?\s*(?:"|in|inch|inches)?$/);
  if (m) {
    let feet = num(m[1]) || 0, inches = m[2] ? num(m[2]) : 0;
    if (m[3] && m[4]) inches += parseInt(m[3], 10) / parseInt(m[4], 10);
    const total = feet + inches / 12;
    return total > 0 ? total : null;
  }
  const n = num(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function num(s) { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; }

// --- Oriented bounding boxes (for furniture/wall collision) ---
// An OBB is { cx, cy, hw, hh, angle } — center, half-width, half-height, radians.

export function obbCorners(o) {
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const axx = c, axy = s;   // local x axis
  const ayx = -s, ayy = c;  // local y axis
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    out.push({
      x: o.cx + axx * o.hw * sx + ayx * o.hh * sy,
      y: o.cy + axy * o.hw * sx + ayy * o.hh * sy,
    });
  }
  return out;
}

// SAT overlap test between two OBBs. Returns the minimum translation vector to
// push A out of B as { x, y, depth }, or null if they don't overlap.
export function obbOverlapMTV(A, B) {
  const ca = Math.cos(A.angle), sa = Math.sin(A.angle);
  const cb = Math.cos(B.angle), sb = Math.sin(B.angle);
  const axes = [
    { x: ca, y: sa }, { x: -sa, y: ca },
    { x: cb, y: sb }, { x: -sb, y: cb },
  ];
  const Ac = obbCorners(A), Bc = obbCorners(B);
  let minOverlap = Infinity, mtvAxis = null;
  for (const ax of axes) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of Ac) { const d = p.x * ax.x + p.y * ax.y; if (d < aMin) aMin = d; if (d > aMax) aMax = d; }
    for (const p of Bc) { const d = p.x * ax.x + p.y * ax.y; if (d < bMin) bMin = d; if (d > bMax) bMax = d; }
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return null; // separating axis found
    if (overlap < minOverlap) { minOverlap = overlap; mtvAxis = ax; }
  }
  const dir = (A.cx - B.cx) * mtvAxis.x + (A.cy - B.cy) * mtvAxis.y < 0 ? -1 : 1;
  return { x: mtvAxis.x * minOverlap * dir, y: mtvAxis.y * minOverlap * dir, depth: minOverlap };
}

// Standard opening sizes (feet)
export const DEFAULT_DOOR_WIDTH_FT = 3;
export const DEFAULT_WINDOW_WIDTH_FT = 4;
export const DOOR_HEIGHT_FT = 7;
export const WINDOW_SILL_FT = 3;
export const WINDOW_HEIGHT_FT = 4; // 3' sill + 4' = 7' head
