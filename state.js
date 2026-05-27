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
  emit();
}

export function armFurniture(catalogId) {
  state.tool = 'furniture';
  state.placingFurniture = catalogId;
  state.placingRot = 0;
  state.selection = null;
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
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  emit();
}
