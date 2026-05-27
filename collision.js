// Furniture ↔ wall (and furniture ↔ furniture) collision in image-pixel space.
// Walls are modeled as thin oriented boxes; furniture as their footprint OBB.
import { state } from './state.js';
import { PX_PER_FT_FALLBACK, wallLengthPx, wallAngle, obbOverlapMTV } from './geom.js';
import { getItem } from './furniture.js';

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

// Slide a piece out of any walls it overlaps, into open space. Iterates so
// corners (two walls) resolve toward the room interior. Mutates f.x/f.y.
export function resolveAgainstWalls(f) {
  const walls = wallOBBs();
  if (!walls.length) return;
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (const W of walls) {
      const A = furnitureOBB(f);
      const m = obbOverlapMTV(A, W);
      if (m && m.depth > 0.01) { f.x += m.x; f.y += m.y; moved = true; }
    }
    if (!moved) break;
  }
}

// True if f still overlaps a wall or another furniture item.
export function isClipping(f) {
  const A = furnitureOBB(f);
  for (const W of wallOBBs()) {
    const m = obbOverlapMTV(A, W);
    if (m && m.depth > CLIP_EPS) return true;
  }
  for (const g of state.furniture) {
    if (g.id === f.id) continue;
    const m = obbOverlapMTV(A, furnitureOBB(g));
    if (m && m.depth > CLIP_EPS) return true;
  }
  return false;
}

// Refresh the transient _clip flag on every furniture item.
export function recomputeClips() {
  for (const f of state.furniture) f._clip = isClipping(f);
}
