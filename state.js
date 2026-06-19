// Shared application state. Coordinates: 2D canvas uses "world" coordinates
// in pixels of the source floor plan image. The scale (pixelsPerFoot) maps
// world pixels to real-world feet for 3D and labeling.

import { getItem } from './furniture.js';

let _nextId = 1;
export const id = () => _nextId++;

export const state = {
  image: null,           // { el: HTMLImageElement, w, h, outline: HTMLCanvasElement }
  imageOpacity: 0.85,
  outlineMode: true,     // show processed glowing-outline instead of raw image
  outlineThreshold: 120, // luminance cutoff: darker than this = wall line
  scale: null,           // pixels per foot (null until calibrated)
  units: 'imperial',     // 'imperial' (ft/in) | 'metric' (m) — display only
  floorStyle: 'wood',    // 3D floor material preset: wood | tile | carpet | concrete
  wallColor: '#e9e6df',  // 3D wall paint colour
  roomFloors: [],        // per-room floor overrides: [{ x, y, style }] keyed by an interior point
  walls: [],             // { id, x1, y1, x2, y2 }
  openings: [],          // { id, type:'door'|'window', wallId, t (0-1), width (ft) }
  furniture: [],         // { id, type (catalog id), x, y, rot (deg) }
  tool: 'pan',
  view: '2d',
  selection: null,       // { kind:'wall'|'opening'|'furniture', id }
  wallHeightFt: 9,
  pan: { x: 0, y: 0 },
  zoom: 1,
  grid: false,           // build-from-scratch: show a 1-ft grid and snap walls to it
  // when drawing a wall: in-progress start point
  draftWallStart: null,
  hover: null,           // for cursor preview: opening preview or wall snap
  scalePick: null,       // 2-point scale calibration: { p1:{x,y}, p2:{x,y}|null }
  placingFurniture: null, // catalog id armed for click-to-drop
  placingRot: 0,         // rotation (deg) of the ghost being placed
  paletteOpen: false,    // Items palette visibility — independent of tool so it
                         // can stay open across drops (tool auto-returns to Pan
                         // after each placement) until the user explicitly closes it
  debugDetect: false,    // draw the ML detection overlay (raw boxes + attach/bridge/drop decisions)
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach(fn => fn()); }

// After loading a project, advance the id counter past all loaded ids so new
// objects don't collide with restored ones.
export function reseedIds() {
  let max = 0;
  for (const arr of [state.walls, state.openings, state.furniture]) {
    for (const o of arr) if (o.id > max) max = o.id;
  }
  _nextId = max + 1;
}

export function setTool(t) {
  state.tool = t;
  state.draftWallStart = null;
  state.selection = null;
  if (t !== 'scale') state.scalePick = null;
  if (t !== 'furniture') state.placingFurniture = null;
  // Toolbar buttons drive palette open/closed: Items opens, anything else closes.
  state.paletteOpen = (t === 'furniture');
  emit();
}

export function armFurniture(catalogId) {
  state.tool = 'furniture';
  state.placingFurniture = catalogId;
  state.placingRot = 0;
  state.selection = null;
  state.paletteOpen = true;
  emit();
}

// Explicit "I'm done dropping items" — close palette and go back to Pan so the
// just-placed items can be clicked to edit. Triggered by × in the palette.
export function closePalette() {
  state.paletteOpen = false;
  state.placingFurniture = null;
  state.selection = null;
  if (state.tool === 'furniture') state.tool = 'pan';
  emit();
}

export function addFurniture(type, x, y, rot = 0) {
  const item = getItem(type);
  // Seed each instance with its own dimensions so resizing one is independent.
  const f = { id: id(), type, x, y, rot, w: item ? item.w : 3, d: item ? item.d : 3 };
  state.furniture.push(f);
  emit();
  return f;
}

export function clearFurniture() {
  state.furniture = [];
  state.selection = null;
  emit();
}

export function setView(v) {
  state.view = v;
  emit();
}

export function setScale(pxPerFt) {
  state.scale = pxPerFt;
  emit();
}

export function addWall(x1, y1, x2, y2, extra) {
  const w = { id: id(), x1, y1, x2, y2, ...extra };
  state.walls.push(w);
  emit();
  return w;
}

export function addOpening(type, wallId, t, widthFt) {
  const o = { id: id(), type, wallId, t, width: widthFt };
  state.openings.push(o);
  emit();
  return o;
}

// Place auto-detected doors/windows. Each item { x1,y1,x2,y2, type, widthFt }
// fills a gap with a short "bridge" wall (tagged auto) plus an opening spanning
// it. Idempotent: a prior run's auto bridges + openings are removed first, so
// re-running replaces rather than stacks.
export function setDetectedOpenings(items) {
  state.walls = state.walls.filter(w => !w.auto);
  state.openings = state.openings.filter(o => !o.auto);
  for (const it of items) {
    const w = { id: id(), x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, auto: true, bridge: true };
    state.walls.push(w);
    state.openings.push({ id: id(), type: it.type, wallId: w.id, t: 0.5, width: it.widthFt, auto: true });
  }
  state.selection = null;
  emit();
}

// Place ML-detected doors/windows. Two item shapes:
//   • { type, wallId, t, widthFt }            → attach to an EXISTING wall
//   • { type, bridge, x1,y1,x2,y2, widthFt }  → drop a short bridge wall at that
//     span and put the opening on it (for openings whose host wall wasn't detected)
// Either way 3D segments a real hole. Idempotent: a prior auto/ML run's openings +
// auto bridge walls are cleared first.
export function setMLOpenings(items) {
  state.walls = state.walls.filter(w => !w.auto);
  state.openings = state.openings.filter(o => !o.auto);
  for (const it of items) {
    if (it.bridge) {
      const w = { id: id(), x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, auto: true, bridge: true };
      state.walls.push(w);
      state.openings.push({ id: id(), type: it.type, wallId: w.id, t: 0.5, width: it.widthFt, auto: true });
    } else if (state.walls.some(w => w.id === it.wallId)) {
      state.openings.push({ id: id(), type: it.type, wallId: it.wallId, t: it.t, width: it.widthFt, auto: true });
    }
  }
  state.selection = null;
  emit();
}

// Hide/show the selected wall, opening, or furniture. Hidden objects lose
// collision and render see-through (a low-opacity "ghost" in 3D/Walk, faint in
// 2D) so you can look past them yet still see them and click to unhide.
export function toggleHidden() {
  const sel = state.selection;
  if (!sel) return;
  const obj = sel.kind === 'wall' ? state.walls.find(w => w.id === sel.id)
    : sel.kind === 'opening' ? state.openings.find(o => o.id === sel.id)
    : sel.kind === 'furniture' ? state.furniture.find(f => f.id === sel.id)
    : null;
  if (!obj) return;
  obj.hidden = !obj.hidden;
  emit();
}

export function showAllHidden() {
  for (const arr of [state.walls, state.openings, state.furniture]) {
    for (const o of arr) delete o.hidden;
  }
  emit();
}

export function deleteSelection() {
  if (!state.selection) return;
  const { kind, id: sid } = state.selection;
  if (kind === 'room') { state.selection = null; emit(); return; } // rooms aren't deletable
  if (kind === 'wall') {
    state.walls = state.walls.filter(w => w.id !== sid);
    state.openings = state.openings.filter(o => o.wallId !== sid);
  } else if (kind === 'furniture') {
    state.furniture = state.furniture.filter(f => f.id !== sid);
  } else {
    const op = state.openings.find(o => o.id === sid);
    state.openings = state.openings.filter(o => o.id !== sid);
    // If it sat on a "bridge" wall (one created only to host an opening across a
    // gap), remove that wall too once empty — so the gap reopens rather than
    // leaving a solid wall behind.
    if (op) {
      const wall = state.walls.find(w => w.id === op.wallId);
      if (wall && wall.bridge && !state.openings.some(o => o.wallId === wall.id)) {
        state.walls = state.walls.filter(w => w.id !== wall.id);
      }
    }
  }
  state.selection = null;
  emit();
}

export function clearWalls() {
  state.walls = [];
  state.openings = [];
  state.selection = null;
  emit();
}

// Replace all walls (e.g. from auto-detection) in one shot. Openings reference
// wall ids that no longer exist, so they're cleared too.
export function replaceWalls(walls) {
  state.walls = walls.map(w => ({ id: id(), x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
  state.openings = [];
  state.selection = null;
  emit();
}

// Place auto-detected structural walls WITHOUT discarding existing doors/windows.
// New walls replace the previous structural walls, but every existing opening is
// RE-HOMED onto the nearest matching-orientation new wall (so the real wall
// segments around it — no wall is drawn over the door); an opening keeps its old
// host (a bridge) only when no new wall lands where it sits. This lets the user
// detect doors/windows FIRST and then walls without losing or covering them.
export function setDetectedWalls(walls) {
  const newWalls = walls.map(w => ({ id: id(), x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
  const oldById = new Map(state.walls.map(w => [w.id, w]));
  const keepOldIds = new Set();
  const TOL = 24; // px — an opening adopts a new wall only if it sits on its line
  for (const o of state.openings) {
    const host = oldById.get(o.wallId);
    if (!host) continue;
    const cx = host.x1 + (host.x2 - host.x1) * o.t;
    const cy = host.y1 + (host.y2 - host.y1) * o.t;
    const openHoriz = Math.abs(host.x2 - host.x1) >= Math.abs(host.y2 - host.y1);
    // Candidate new walls of matching orientation that the opening actually falls
    // WITHIN (not clamped past an end), nearest first.
    const cands = [];
    for (const w of newWalls) {
      if ((Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1)) !== openHoriz) continue; // orientation
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1, L2 = dx * dx + dy * dy || 1;
      const uRaw = ((cx - w.x1) * dx + (cy - w.y1) * dy) / L2;
      if (uRaw < -0.05 || uRaw > 1.05) continue; // opening sits beyond this wall's span
      const u = Math.max(0, Math.min(1, uRaw));
      const d = Math.hypot(cx - (w.x1 + u * dx), cy - (w.y1 + u * dy));
      cands.push({ w, u, d });
    }
    cands.sort((a, b) => a.d - b.d);
    const best = cands[0], second = cands[1];
    // Attach the opening to a new wall when either it PLAINLY lies on one (tiny
    // distance — adopt the nearest even if a parallel face is right behind it, e.g. the
    // two edges of one wall), or one wall is unambiguously closer than the next. Else
    // keep the bridge so the opening stays exactly where the detector placed it.
    const onWall = best && best.d <= 7;
    const unambiguous = best && (!second || second.d > best.d * 1.5 + 6);
    if (best && best.d <= TOL && (onWall || unambiguous)) { o.wallId = best.w.id; o.t = best.u; }
    else keepOldIds.add(host.id);
  }
  state.walls = [...newWalls, ...state.walls.filter(w => keepOldIds.has(w.id))];
  healBridges(state.walls);
  logHealState();
  state.selection = null;
  emit();
}

// Connect generated walls to a floating opening's bridge: a real wall whose END
// lands near a bridge endpoint is snapped onto it, so the surrounding walls join
// up to the door/window instead of leaving it an isolated "island" (which also
// produces stray ceiling slivers in 3D). Only walls already CLOSE to the opening
// are pulled in, so nothing stretches across the room.
// Close the gap between a detected door/window and the walls around it, so NOTHING is
// left floating. The DOOR/WINDOW IS THE SOURCE OF TRUTH — it never moves or resizes.
// The walls accommodate it: for each door jamb (each end of a floating opening), the
// nearest real wall is made to PASS THROUGH that jamb while staying axis-aligned —
// nudge the wall's line onto the jamb (a small perpendicular shift) and extend the
// wall's end along its own axis to reach it. Never an angle, and the opening is left
// exactly where the model placed it.
//   cost = shift (move the wall's line onto the jamb) + growth (extend the wall to it).
// Both are capped so we only ever make the "wall drawn a touch short / a few px off"
// correction — a wall never travels across the room to chase a door.
function healBridges(walls) {
  const bridges = walls.filter(w => w.bridge);
  if (!bridges.length) return;
  // Only real, AXIS-ALIGNED walls can heal — nudging/extending a diagonal wall would
  // only worsen the diagonal, so those are left for manual cleanup.
  const realWalls = walls.filter(w => !w.bridge
    && (Math.abs(w.x2 - w.x1) <= 2 || Math.abs(w.y2 - w.y1) <= 2));
  if (!realWalls.length) return;
  const SHIFT_CAP = 18; // px — most a wall's line may slide sideways onto a jamb
  const GROW_CAP = 26;  // px — most a wall may extend along its axis to reach a jamb
  const SHIFT_PENALTY = 1.5; // a sideways nudge is slightly worse than a clean axial extend

  // Extend a wall's nearer end out along its axis to a target coord — only when the
  // target is past the wall's span (a no-op when the jamb already lies on the wall body).
  const growX = (w, x) => {
    if (x > Math.max(w.x1, w.x2)) { if (w.x1 >= w.x2) w.x1 = x; else w.x2 = x; }
    else if (x < Math.min(w.x1, w.x2)) { if (w.x1 <= w.x2) w.x1 = x; else w.x2 = x; }
  };
  const growY = (w, y) => {
    if (y > Math.max(w.y1, w.y2)) { if (w.y1 >= w.y2) w.y1 = y; else w.y2 = y; }
    else if (y < Math.min(w.y1, w.y2)) { if (w.y1 <= w.y2) w.y1 = y; else w.y2 = y; }
  };
  const spanGap = (v, lo, hi) => v < lo ? lo - v : v > hi ? v - hi : 0; // px past a span

  for (const b of bridges) {
    for (const bk of ['1', '2']) {
      const bx = b['x' + bk], by = b['y' + bk]; // a door/window jamb — FIXED
      // Find the wall that can pass through (bx,by) for the least movement. A wall is
      // made axis-aligned-through-the-jamb either way: a horizontal wall needs y→by and
      // its end out to x=bx; a vertical wall needs x→bx and its end out to y=by.
      let best = null, bestCost = SHIFT_CAP + GROW_CAP;
      for (const w of realWalls) {
        const wHoriz = Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1);
        const shift  = wHoriz ? Math.abs((w.y1 + w.y2) / 2 - by) : Math.abs((w.x1 + w.x2) / 2 - bx);
        const growth = wHoriz ? spanGap(bx, Math.min(w.x1, w.x2), Math.max(w.x1, w.x2))
                              : spanGap(by, Math.min(w.y1, w.y2), Math.max(w.y1, w.y2));
        if (shift > SHIFT_CAP || growth > GROW_CAP) continue; // too far to be "its" wall
        const cost = SHIFT_PENALTY * shift + growth;
        if (cost < bestCost) { best = { w, wHoriz }; bestCost = cost; }
      }
      if (!best) continue;
      const { w, wHoriz } = best; // accommodate the door: wall passes through the jamb
      if (wHoriz) { w.y1 = w.y2 = by; growX(w, bx); }
      else        { w.x1 = w.x2 = bx; growY(w, by); }
    }
  }
}

const HEAL_DEBUG = false; // set true to log walls/bridges after detect-walls (diagnostic)
function logHealState() {
  if (!HEAL_DEBUG || typeof console === 'undefined') return;
  const cls = w => Math.abs(w.x2 - w.x1) < 2 ? 'V' : Math.abs(w.y2 - w.y1) < 2 ? 'H' : 'DIAG';
  const fmt = w => `${cls(w)}\t(${w.x1 | 0},${w.y1 | 0})-(${w.x2 | 0},${w.y2 | 0})`;
  const bridges = state.walls.filter(w => w.bridge), real = state.walls.filter(w => !w.bridge);
  console.log(`[HEAL] ${real.length} walls, ${bridges.length} bridges\n` +
    'BRIDGES (door/window carriers):\n' + bridges.map(fmt).join('\n') +
    '\nWALLS:\n' + real.map(fmt).join('\n'));
}

export function clearOpenings() {
  state.openings = [];
  state.selection = null;
  emit();
}

export function resetAll() {
  state.image = null;
  state.scale = null;
  state.walls = [];
  state.openings = [];
  state.furniture = [];
  state.selection = null;
  state.draftWallStart = null;
  state.placingFurniture = null;
  state.paletteOpen = false;
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  emit();
}
