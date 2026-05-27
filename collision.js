// Furniture ↔ wall (and furniture ↔ furniture) collision in image-pixel space.
// Walls are modeled as thin oriented boxes; furniture as their footprint OBB.
import { state } from './state.js';
import { PX_PER_FT_FALLBACK, wallLengthPx, wallAngle, obbOverlapMTV, nearestWall } from './geom.js';
import { getItem, applyResize } from './furniture.js';

const WALL_THICK_FT = 0.5;
const CLIP_EPS = 0.5; // px overlap below which we treat as "just touching"

function pxPerFt() { return state.scale ?? PX_PER_FT_FALLBACK; }

export function furnitureOBB(f) {
  const item = getItem(f.type);
  const w = f.w ?? (item ? item.w : 2), d = f.d ?? (item ? item.d : 2);
  return { cx: f.x, cy: f.y, hw: (w * pxPerFt()) / 2, hh: (d * pxPerFt()) / 2, angle: (f.rot || 0) * Math.PI / 180 };
}

function wallOBBs() {
  const hh = (WALL_THICK_FT * pxPerFt()) / 2;
  return state.walls.map(w => ({
    cx: (w.x1 + w.x2) / 2, cy: (w.y1 + w.y2) / 2,
    hw: wallLengthPx(w) / 2, hh, angle: wallAngle(w),
  }));
}

// Pose (image px) for a wall-mounted item placed near (x,y): flush against the
// nearest wall, facing the building interior, oriented along the wall. Returns
// { x, y, rot } or null if there are no walls. Used for both placed items and
// the live placement ghost (so it rides the wall before you drop it).
export function wallSnapPose(item, x, y, d) {
  const near = nearestWall(state.walls, x, y, Infinity);
  if (!near) return null;
  const wall = near.wall;
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;              // wall normal
  // Mount on the side the cursor/item is on — robust for any layout (you choose
  // the side by where you point, and the live ghost shows it).
  const side = ((x - near.x) * nx + (y - near.y) * ny) >= 0 ? 1 : -1;
  nx *= side; ny *= side;
  const dd = d ?? item.d;
  const offset = ((WALL_THICK_FT / 2 + dd / 2) * pxPerFt());
  return { x: near.x + nx * offset, y: near.y + ny * offset, rot: wallAngle(wall) * 180 / Math.PI };
}

// Snap a placed wall-mounted item flush against the nearest wall. Mutates f.
export function snapToWall(f) {
  const item = getItem(f.type);
  if (!item) return;
  const pose = wallSnapPose(item, f.x, f.y, f.d ?? item.d);
  if (!pose) return; // no walls yet — leave it where it is
  f.x = pose.x; f.y = pose.y; f.rot = pose.rot;
}

// Slide a piece out of any walls OR other floor furniture it overlaps, into open
// space. Iterates so it settles out of multiple obstacles (corners, packed
// items). Mutates f.x/f.y. Wall-mounted items snap to a wall instead, and are
// elevated so floor items pass under them (not obstacles).
export function resolveAgainstWalls(f) {
  if (getItem(f.type)?.mount === 'wall') { snapToWall(f); return; }
  const obstacles = wallOBBs();
  for (const g of state.furniture) {
    if (g.id === f.id || getItem(g.type)?.mount === 'wall') continue;
    obstacles.push(furnitureOBB(g));
  }
  if (!obstacles.length) return;
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (const O of obstacles) {
      const A = furnitureOBB(f);
      const m = obbOverlapMTV(A, O);
      if (m && m.depth > 0.01) { f.x += m.x; f.y += m.y; moved = true; }
    }
    if (!moved) break;
  }
}

// The deepest wall the piece still overlaps (MTV), or null.
function deepestWallOverlap(f) {
  const A = furnitureOBB(f);
  let best = null;
  for (const W of wallOBBs()) {
    const m = obbOverlapMTV(A, W);
    if (m && m.depth > CLIP_EPS && (!best || m.depth > best.depth)) best = m;
  }
  return best;
}

// Place a piece into a gap: push it out of walls, and if it's still wedged
// between two walls (can't push out), shrink the constrained dimension until it
// fits, then re-center. Resizable items only ('fixed'/'snap' just get pushed).
export function fitBetweenWalls(f) {
  const item = getItem(f.type);
  if (!item) return;
  if (item.mount === 'wall') { snapToWall(f); return; }
  resolveAgainstWalls(f);
  if (item.resize === 'fixed' || item.resize === 'snap') return;
  const clearanceFt = 0.05;
  for (let i = 0; i < 30; i++) {
    const m = deepestWallOverlap(f);
    if (!m) return; // fits now
    // Which of the item's local axes is being squeezed?
    const a = (f.rot || 0) * Math.PI / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const nx = m.x / m.depth, ny = m.y / m.depth;
    const alongW = Math.abs(nx * cos + ny * sin);
    const alongD = Math.abs(nx * -sin + ny * cos);
    const axis = alongW >= alongD ? 'w' : 'd';
    const shrinkFt = (2 * m.depth) / pxPerFt() + clearanceFt;
    const cur = axis === 'w' ? f.w : f.d;
    const next = applyResize(item, axis, cur - shrinkFt, { w: f.w, d: f.d });
    // hit the minimum size and still doesn't fit → give up (will be flagged)
    if ((axis === 'w' ? next.w : next.d) >= cur - 1e-4) return;
    f.w = next.w; f.d = next.d;
    resolveAgainstWalls(f); // re-center in the gap at the new size
  }
}

// True if f still overlaps a wall or another furniture item. Wall-mounted items
// are elevated, so they never clip (and floor items ignore them).
export function isClipping(f) {
  if (getItem(f.type)?.mount === 'wall') return false;
  const A = furnitureOBB(f);
  for (const W of wallOBBs()) {
    const m = obbOverlapMTV(A, W);
    if (m && m.depth > CLIP_EPS) return true;
  }
  for (const g of state.furniture) {
    if (g.id === f.id || getItem(g.type)?.mount === 'wall') continue;
    const m = obbOverlapMTV(A, furnitureOBB(g));
    if (m && m.depth > CLIP_EPS) return true;
  }
  return false;
}

// Refresh the transient _clip flag on every furniture item.
export function recomputeClips() {
  for (const f of state.furniture) f._clip = isClipping(f);
}
