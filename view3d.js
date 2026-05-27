// 3D view: build scene from state, OrbitControls + click-drag walk mode.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, subscribe, emit, addFurniture } from './state.js';
import {
  dist, wallLengthPx, wallsBoundingBox, PX_PER_FT_FALLBACK,
  DOOR_HEIGHT_FT, WINDOW_SILL_FT, WINDOW_HEIGHT_FT,
  pointOnWall, projectPointToSegment, wallAngle,
} from './geom.js';
import { getItem, unitCount, applyResize } from './furniture.js';
import { resolveAgainstWalls, fitBetweenWalls, recomputeClips, wallSnapPose } from './collision.js';

const canvas = document.getElementById('canvas3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16171a);
scene.fog = new THREE.Fog(0x16171a, 60, 250);

const ORBIT_FOV = 50;
const WALK_FOV = 75;
const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.1, 500);
camera.position.set(30, 30, 30);
camera.lookAt(0, 0, 0);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;
orbit.minDistance = 5;
orbit.maxDistance = 200;

// Lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x404556, 0.75);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
scene.add(sun);

// Material library
const matWall = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.85, metalness: 0 });
const matDoorJamb = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.7 });
const matWindow = new THREE.MeshStandardMaterial({
  color: 0x88c0ff, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.45,
});

const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

const WALL_THICKNESS_FT = 0.5;

function effectiveScale() {
  return state.scale ?? PX_PER_FT_FALLBACK; // shared fallback keeps 2D/3D consistent
}

function px2ft(px) { return px / effectiveScale(); }

// Convert pixel coord (x,y) to world 3D feet (x, _, z). Center on walls bbox.
let _offset = { x: 0, y: 0 };
function computeOffset() {
  const bb = wallsBoundingBox(state.walls);
  if (!bb) { _offset = { x: 0, y: 0 }; return; }
  _offset = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
}
function px3(x, y) {
  return new THREE.Vector3(px2ft(x - _offset.x), 0, px2ft(y - _offset.y));
}

// Whole-home floor materials (approximated with colour + roughness, no textures).
const FLOOR_PRESETS = {
  wood:     { color: 0x9c6b40, rough: 0.70 },
  tile:     { color: 0xd0d3cd, rough: 0.35 },
  carpet:   { color: 0x9c9488, rough: 0.97 },
  concrete: { color: 0x8d8f92, rough: 0.90 },
};

// Apply the global wall colour to the shared wall material (floors use
// floorMatFor per room / globally).
function applyStyle() {
  if (state.wallColor) matWall.color.set(state.wallColor);
}

// Material for a wall: its own colour if set, else the shared (global) material.
// Per-colour materials are cached so we don't churn one per segment.
const wallMatCache = new Map();
function wallMat(wall) {
  if (!wall.color) return matWall;
  let m = wallMatCache.get(wall.color);
  if (!m) { m = matWall.clone(); wallMatCache.set(wall.color, m); }
  m.color.set(wall.color);
  return m;
}

// ---- Floor materials + per-room floors -------------------------------------
const floorMatCache = new Map();
function floorMatFor(style) {
  const fp = FLOOR_PRESETS[style] || FLOOR_PRESETS.wood;
  let m = floorMatCache.get(style);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: fp.color, roughness: fp.rough }); floorMatCache.set(style, m); }
  return m;
}

// Rooms = enclosed regions found by flood-filling the wall-bounded floor. Walls
// (full centerlines, incl. door spans) are barriers, so doorways don't merge
// rooms. Cached by walls+overrides so it isn't recomputed during furniture drags.
let _roomCache = null, _roomSig = '';
function getRooms() {
  const sig = effectiveScale().toFixed(2) + '|' +
    state.walls.map(w => `${w.x1 | 0},${w.y1 | 0},${w.x2 | 0},${w.y2 | 0}`).join(';') + '|' +
    JSON.stringify(state.roomFloors || []);
  if (sig !== _roomSig) { _roomCache = detectRooms(); _roomSig = sig; }
  return _roomCache;
}

function detectRooms() {
  const bb = wallsBoundingBox(state.walls);
  if (!bb || state.walls.length < 3) return [];
  const sc = effectiveScale();
  const cell = Math.max(4, sc * 0.5); // ~0.5 ft cells
  const margin = cell * 2;
  const ox = bb.minX - margin, oy = bb.minY - margin;
  const W = Math.ceil((bb.w + margin * 2) / cell);
  const H = Math.ceil((bb.h + margin * 2) / cell);
  if (W < 3 || H < 3 || W * H > 200000) return [];

  const barrier = new Uint8Array(W * H);
  const r = Math.max(0, Math.round((WALL_THICKNESS_FT * sc) / cell / 2));
  for (const w of state.walls) {
    const steps = Math.ceil(dist(w.x1, w.y1, w.x2, w.y2) / (cell * 0.5)) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const gx = Math.floor(((w.x1 + (w.x2 - w.x1) * t) - ox) / cell);
      const gy = Math.floor(((w.y1 + (w.y2 - w.y1) * t) - oy) / cell);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) barrier[y * W + x] = 1;
      }
    }
  }

  const reg = new Int32Array(W * H).fill(-1);
  const stack = [];
  const regions = [];
  let id = 0;
  for (let i0 = 0; i0 < W * H; i0++) {
    if (barrier[i0] || reg[i0] !== -1) continue;
    reg[i0] = id; stack.length = 0; stack.push(i0);
    const cells = []; let exterior = false;
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const cx = c % W, cy = (c / W) | 0;
      if (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) exterior = true;
      if (cx > 0 && !barrier[c - 1] && reg[c - 1] === -1) { reg[c - 1] = id; stack.push(c - 1); }
      if (cx < W - 1 && !barrier[c + 1] && reg[c + 1] === -1) { reg[c + 1] = id; stack.push(c + 1); }
      if (cy > 0 && !barrier[c - W] && reg[c - W] === -1) { reg[c - W] = id; stack.push(c - W); }
      if (cy < H - 1 && !barrier[c + W] && reg[c + W] === -1) { reg[c + W] = id; stack.push(c + W); }
    }
    regions.push({ id, cells, exterior }); id++;
  }

  const minCells = Math.max(8, Math.round(W * H * 0.004));
  const rooms = [];
  for (const region of regions) {
    if (region.exterior || region.cells.length < minCells) continue;
    let sx = 0, sy = 0;
    for (const c of region.cells) { sx += c % W; sy += (c / W) | 0; }
    const ccx = sx / region.cells.length, ccy = sy / region.cells.length;
    let repCell = region.cells[0], best = Infinity;
    for (const c of region.cells) { const dx = c % W - ccx, dy = ((c / W) | 0) - ccy; const dd = dx * dx + dy * dy; if (dd < best) { best = dd; repCell = c; } }
    const repX = ox + (repCell % W + 0.5) * cell;
    const repY = oy + (((repCell / W) | 0) + 0.5) * cell;
    const key = `${Math.round(repX)},${Math.round(repY)}`;
    let style = state.floorStyle;
    for (const o of (state.roomFloors || [])) {
      const gx = Math.floor((o.x - ox) / cell), gy = Math.floor((o.y - oy) / cell);
      if (gx >= 0 && gy >= 0 && gx < W && gy < H && reg[gy * W + gx] === region.id) { style = o.style; break; }
    }
    const patches = rectsFromCells(region.cells, W).map(rc => {
      const x0 = ox + rc.gx0 * cell, x1 = ox + rc.gx1 * cell;
      const y0 = oy + rc.gy0 * cell, y1 = oy + rc.gy1 * cell;
      return {
        cx: px2ft((x0 + x1) / 2 - _offset.x), cz: px2ft((y0 + y1) / 2 - _offset.y),
        ww: px2ft(x1 - x0), wd: px2ft(y1 - y0),
      };
    });
    rooms.push({ key, style, x: repX, y: repY, patches });
  }
  return rooms;
}

// Partition a region's cells into maximal rectangles (greedy meshing) so each
// room renders as a few large floor quads instead of thousands of cells.
function rectsFromCells(cells, W) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const c of cells) { const x = c % W, y = (c / W) | 0; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  const gw = maxx - minx + 1, gh = maxy - miny + 1;
  const inR = new Uint8Array(gw * gh);
  for (const c of cells) inR[((c / W | 0) - miny) * gw + (c % W - minx)] = 1;
  const used = new Uint8Array(gw * gh);
  const rects = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inR[y * gw + x] || used[y * gw + x]) continue;
    let w = 1; while (x + w < gw && inR[y * gw + x + w] && !used[y * gw + x + w]) w++;
    let h = 1;
    grow: while (y + h < gh) { for (let k = 0; k < w; k++) { const idx = (y + h) * gw + (x + k); if (!inR[idx] || used[idx]) break grow; } h++; }
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) used[(y + yy) * gw + (x + xx)] = 1;
    rects.push({ gx0: minx + x, gy0: miny + y, gx1: minx + x + w, gy1: miny + y + h });
  }
  return rects;
}

function addRoomFloors(rooms) {
  for (const room of rooms) {
    const mat = floorMatFor(room.style);
    for (const p of room.patches) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(p.ww, p.wd), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(p.cx, 0, p.cz);
      m.receiveShadow = true;
      m.userData.roomKey = room.key;
      m.userData.roomStyle = room.style;
      m.userData.roomX = room.x;
      m.userData.roomY = room.y;
      sceneRoot.add(m);
    }
  }
}

// Build the scene from current state.
export function rebuild() {
  applyStyle();
  computeOffset();
  while (sceneRoot.children.length) {
    const c = sceneRoot.children.pop();
    c.traverse?.(o => { o.geometry?.dispose?.(); });
  }

  if (state.furniture.length) recomputeClips();
  if (state.walls.length === 0 && state.furniture.length === 0) return;

  if (state.walls.length > 0) {
    const bb = wallsBoundingBox(state.walls);
    const rooms = getRooms();
    if (rooms.length) {
      addRoomFloors(rooms); // per-room floor patches (own material each)
    } else {
      // No enclosed rooms detected — one floor at the global material.
      const floorW = px2ft(bb.w) + 8, floorH = px2ft(bb.h) + 8;
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorH), floorMatFor(state.floorStyle));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      sceneRoot.add(floor);
    }

    // Grid helper for orientation
    const span = px2ft(Math.max(bb.w, bb.h)) + 8;
    const grid = new THREE.GridHelper(span, Math.round(span));
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    grid.position.y = 0.01;
    sceneRoot.add(grid);
  }

  // Per wall: build segments (with cutouts above/below openings)
  const wallHeight = state.wallHeightFt;
  for (const w of state.walls) {
    const openings = state.openings.filter(o => o.wallId === w.id);
    const segments = buildWallSegments(w, openings, wallHeight);
    for (const seg of segments) {
      const mesh = buildWallSegmentMesh(w, seg);
      if (mesh) sceneRoot.add(mesh);
    }
    // Window glass panes
    for (const o of openings.filter(o => o.type === 'window')) {
      const pane = buildWindowPane(w, o);
      if (pane) sceneRoot.add(pane);
    }
    // Door jambs (slim frame inside cutout)
    for (const o of openings.filter(o => o.type === 'door')) {
      const jamb = buildDoorJamb(w, o);
      if (jamb) sceneRoot.add(jamb);
    }
    // Invisible pick proxies so doors/windows are clickable/selectable in 3D
    for (const o of openings) {
      const proxy = buildOpeningProxy(o);
      if (proxy) sceneRoot.add(proxy);
    }
  }

  // Furniture & fixtures
  for (const f of state.furniture) {
    const g = buildFurniture(f);
    if (g) sceneRoot.add(g);
    if (f._clip) {
      const marker = buildClipMarker(f);
      if (marker) sceneRoot.add(marker);
    }
  }

  // Drag handles for the currently selected item
  buildSelectionHandles();
}

const matClip = new THREE.LineBasicMaterial({ color: 0xff4d4d });
function buildClipMarker(f) {
  const item = getItem(f.type);
  if (!item) return null;
  const w = f.w ?? item.w, d = f.d ?? item.d, h = item.h;
  const geo = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(geo);
  geo.dispose();
  const line = new THREE.LineSegments(edges, matClip);
  line.position.set(px2ft(f.x - _offset.x), h / 2, px2ft(f.y - _offset.y));
  line.rotation.y = -(f.rot || 0) * Math.PI / 180;
  return line;
}

// ---- Furniture proxies ----
const matFurnWood = new THREE.MeshStandardMaterial({ color: 0x9c6b40, roughness: 0.7 });
const matFurnFabric = new THREE.MeshStandardMaterial({ color: 0x8f99a6, roughness: 0.95 });
const matFurnMetal = new THREE.MeshStandardMaterial({ color: 0x6a6e74, roughness: 0.4, metalness: 0.5 });
const matFurnAppliance = new THREE.MeshStandardMaterial({ color: 0xd0d4da, roughness: 0.35, metalness: 0.3 });
const matFurnCeramic = new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.25 });
const matFurnDark = new THREE.MeshStandardMaterial({ color: 0x26282c, roughness: 0.5 });
const matFurnMattress = new THREE.MeshStandardMaterial({ color: 0xeceef1, roughness: 0.9 });
const matFurnCounter = new THREE.MeshStandardMaterial({ color: 0x7d6b56, roughness: 0.6 });
const matFurnBasin = new THREE.MeshStandardMaterial({ color: 0xccd2d8, roughness: 0.35 });

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A recessed basin centered at local x=cx: the surface is built as a rim (four
// strips around a hole) plus a sunk well bottom, so it reads as a real divot.
function addBasin(g, cx, surfW, surfD, yTop, slabT, basinW, basinD, wellDepth, rimMat, wellMat) {
  const frontD = (surfD - basinD) / 2;
  const sideW = (surfW - basinW) / 2;
  g.add(box(surfW, slabT, frontD, rimMat, cx, yTop - slabT / 2, -(surfD / 2 - frontD / 2)));
  g.add(box(surfW, slabT, frontD, rimMat, cx, yTop - slabT / 2, (surfD / 2 - frontD / 2)));
  g.add(box(sideW, slabT, basinD, rimMat, cx - (surfW / 2 - sideW / 2), yTop - slabT / 2, 0));
  g.add(box(sideW, slabT, basinD, rimMat, cx + (surfW / 2 - sideW / 2), yTop - slabT / 2, 0));
  g.add(box(basinW, slabT * 0.7, basinD, wellMat, cx, yTop - wellDepth, 0));
}

// Build a furniture group sized in feet, origin at footprint center on floor.
// `dims` = { w, d, h, kind, count, sink } where count = repeating-unit count.
function buildFurnitureGroup(dims) {
  const { w, d, h, kind, count = 1 } = dims;
  const g = new THREE.Group();
  switch (kind) {
    case 'bed': {
      const frameH = h * 0.45;
      g.add(box(w, frameH, d, matFurnWood, 0, frameH / 2, 0));
      const matT = h * 0.5;
      g.add(box(w * 0.96, matT, d * 0.94, matFurnMattress, 0, frameH + matT / 2, 0));
      // pillows at the head (−d side) — one per ~26" of width
      const npil = Math.max(1, Math.round(w / (26 / 12)));
      const pw = (w * 0.9) / npil * 0.85, pd = d * 0.12, ph = h * 0.18;
      for (let i = 0; i < npil; i++) {
        const px = -w * 0.45 + (i + 0.5) * (w * 0.9 / npil);
        g.add(box(pw, ph, pd, matFurnFabric, px, frameH + matT + ph / 2 - 0.02, -d / 2 + pd));
      }
      break;
    }
    case 'sofa': {
      const seatH = h * 0.45, armW = Math.min(w * 0.12, 0.5), backD = d * 0.25;
      g.add(box(w, seatH, d, matFurnFabric, 0, seatH / 2, 0));               // base
      g.add(box(w, h * 0.55, backD, matFurnFabric, 0, h * 0.55 / 2 + seatH * 0.4, -d / 2 + backD / 2)); // back
      g.add(box(armW, h * 0.55, d, matFurnFabric, -w / 2 + armW / 2, h * 0.55 / 2 + seatH * 0.3, 0));
      g.add(box(armW, h * 0.55, d, matFurnFabric, w / 2 - armW / 2, h * 0.55 / 2 + seatH * 0.3, 0));
      // seat cushions, one per unit
      const innerW = w - armW * 2;
      const cw = innerW / count;
      for (let i = 0; i < count; i++) {
        const cx = -innerW / 2 + (i + 0.5) * cw;
        g.add(box(cw * 0.92, h * 0.12, d * 0.8, matFurnMattress, cx, seatH + h * 0.06, backD * 0.3));
      }
      break;
    }
    case 'chair': {
      const seatH = h * 0.5, t = Math.min(w, d) * 0.1;
      g.add(box(w, t, d, matFurnFabric, 0, seatH, 0));                       // seat
      g.add(box(w, h - seatH, d * 0.12, matFurnFabric, 0, seatH + (h - seatH) / 2, -d / 2 + d * 0.06)); // back
      const lx = w / 2 - t, lz = d / 2 - t;
      for (const sx of [-lx, lx]) for (const sz of [-lz, lz]) g.add(box(t, seatH, t, matFurnMetal, sx, seatH / 2, sz));
      break;
    }
    case 'table': {
      const topT = Math.max(0.1, h * 0.08), legT = Math.min(w, d) * 0.1;
      g.add(box(w, topT, d, matFurnWood, 0, h - topT / 2, 0));
      const lx = w / 2 - legT, lz = d / 2 - legT;
      for (const sx of [-lx, lx]) for (const sz of [-lz, lz]) g.add(box(legT, h - topT, legT, matFurnWood, sx, (h - topT) / 2, sz));
      break;
    }
    case 'toilet': {
      const tankD = d * 0.28;
      g.add(box(w * 0.9, h * 0.72, tankD, matFurnCeramic, 0, h * 0.4, -d / 2 + tankD / 2)); // tank
      g.add(box(w * 0.5, h * 0.4, d * 0.5, matFurnCeramic, 0, h * 0.2, d * 0.08));           // pedestal
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.46, w * 0.36, h * 0.3, 20), matFurnCeramic);
      bowl.position.set(0, h * 0.55, d * 0.12); bowl.castShadow = true; g.add(bowl);
      const seat = new THREE.Mesh(new THREE.TorusGeometry(w * 0.4, w * 0.12, 12, 22), matFurnCeramic); // seat ring
      seat.rotation.x = Math.PI / 2; seat.position.set(0, h * 0.7, d * 0.12); g.add(seat);
      const innerBowl = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.22, h * 0.12, 18), matFurnBasin);
      innerBowl.position.set(0, h * 0.64, d * 0.12); g.add(innerBowl);                       // bowl divot
      break;
    }
    case 'sink': {
      g.add(box(w, h * 0.82, d, matFurnWood, 0, h * 0.41, 0)); // vanity cabinet
      const yTop = h, slabT = h * 0.1, bayW = w / count;
      for (let i = 0; i < count; i++) {
        const cx = -w / 2 + (i + 0.5) * bayW;
        addBasin(g, cx, bayW, d, yTop, slabT, bayW * 0.62, d * 0.6, 0.16, matFurnCeramic, matFurnBasin);
        g.add(box(0.1, 0.36, 0.1, matFurnMetal, cx, yTop + 0.18, -d * 0.32));                 // faucet
        g.add(box(0.1, 0.08, 0.2, matFurnMetal, cx, yTop + 0.34, -d * 0.32 + 0.1));            // spout
      }
      break;
    }
    case 'tub': {
      const wallT = Math.min(w, d) * 0.12;
      g.add(box(w, h * 0.2, d, matFurnCeramic, 0, h * 0.1, 0));                       // floor
      g.add(box(w, h, wallT, matFurnCeramic, 0, h / 2, -d / 2 + wallT / 2));          // back wall
      g.add(box(w, h, wallT, matFurnCeramic, 0, h / 2, d / 2 - wallT / 2));           // front wall
      g.add(box(wallT, h, d, matFurnCeramic, -w / 2 + wallT / 2, h / 2, 0));          // left wall
      g.add(box(wallT, h, d, matFurnCeramic, w / 2 - wallT / 2, h / 2, 0));           // right wall
      g.add(box(w - wallT * 2, h * 0.04, d - wallT * 2, matFurnBasin, 0, h * 0.21, 0)); // inner well floor
      const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 12), matFurnMetal);
      drain.position.set(w * 0.3, h * 0.22, 0); g.add(drain);
      g.add(box(0.12, 0.4, 0.12, matFurnMetal, -w / 2 + wallT + 0.12, h + 0.2, 0));   // faucet
      break;
    }
    case 'stove': {
      g.add(box(w, h * 0.9, d, matFurnAppliance, 0, h * 0.45, 0));           // body
      g.add(box(w * 0.96, h * 0.06, d * 0.96, matFurnDark, 0, h * 0.93, 0)); // cooktop
      const br = Math.min(w, d) * 0.16;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const burner = new THREE.Mesh(new THREE.CylinderGeometry(br, br, 0.04, 18), matFurnMetal);
        burner.position.set(sx * w * 0.26, h * 0.97, sz * d * 0.22); g.add(burner);
      }
      g.add(box(w * 0.72, 0.08, 0.06, matFurnMetal, 0, h * 0.5, d / 2 + 0.02)); // oven handle
      break;
    }
    case 'counter': {
      g.add(box(w, h * 0.92, d, matFurnWood, 0, h * 0.46, 0)); // cabinet
      const yTop = h, slabT = h * 0.08;
      for (let i = 1; i < count; i++) { // cabinet-bay seams
        const sx = -w / 2 + i * (w / count);
        g.add(box(0.04, h * 0.9, d, matFurnDark, sx, h * 0.46, 0));
      }
      if (dims.sink) {
        const bayW = w / count;
        for (let i = 0; i < count; i++) {
          const cx = -w / 2 + (i + 0.5) * bayW;
          addBasin(g, cx, bayW, d, yTop, slabT, bayW * 0.6, d * 0.6, 0.16, matFurnCounter, matFurnBasin);
          g.add(box(0.1, 0.34, 0.1, matFurnMetal, cx, yTop + 0.17, -d * 0.32)); // faucet
        }
      } else {
        g.add(box(w, slabT, d, matFurnCounter, 0, yTop - slabT / 2, 0)); // full countertop
      }
      break;
    }
    case 'appliance': {
      g.add(box(w, h, d, matFurnAppliance, 0, h / 2, 0));
      g.add(box(0.08, h * 0.5, 0.08, matFurnMetal, w * 0.38, h * 0.52, d / 2 + 0.04)); // handle
      if (h > 4) g.add(box(w * 0.98, 0.04, 0.02, matFurnDark, 0, h * 0.62, d / 2 + 0.02)); // fridge door seam
      break;
    }
    case 'box':
    default: {
      const mat = dims.dark ? matFurnDark : matFurnWood;
      g.add(box(w, h, d, mat, 0, h / 2, 0));
      break;
    }
  }
  return g;
}

function buildFurniture(f) {
  const item = getItem(f.type);
  if (!item) return null;
  const w = f.w ?? item.w, d = f.d ?? item.d;
  const dims = {
    w, d, h: item.h, kind: item.kind,
    count: unitCount(item, w),
    sink: !!item.sink,
    dark: item.color === '#3a3d42',
  };
  const g = buildFurnitureGroup(dims);
  g.userData.furnitureId = f.id;
  const mountY = item.mount === 'wall' ? (f.mountH ?? item.mountH ?? 4) : 0; // lift wall items off the floor
  g.position.set(px2ft(f.x - _offset.x), mountY, px2ft(f.y - _offset.y));
  g.rotation.y = -(f.rot || 0) * Math.PI / 180;
  return g;
}

// ---- 3D manipulation: placement, select, move, resize (furniture + openings) ----
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPt = new THREE.Vector3();
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffd2d4, transparent: true, opacity: 0.45, depthWrite: false });
const matHandle = new THREE.MeshBasicMaterial({ color: 0xff3b43, depthTest: false });
const HANDLE_R = 0.5; // ft

let ghost = null;          // { type, rot, group }
let lastFloorPt = null;    // last world point under cursor on the floor
let manip = null;          // active manipulation: { kind, id, axis|edge, offx, offy }
let suppressLook = false;  // pause walk look while manipulating
let downXY = null;         // screen pos at pointerdown (click-vs-drag detection)
let handleMeshes = [];     // raycast targets for the selected item's handles

function ndcFromEvent(e) {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  return _ndc;
}

function floorPointFromEvent(e) {
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hit = _ray.ray.intersectPlane(_floorPlane, _hitPt);
  return hit ? { x: hit.x, z: hit.z } : null;
}

// World point where the cursor ray actually hits a WALL mesh. Used for placing/
// moving wall-mounted items by pointing AT the wall — the floor projection would
// sail over a near wall and land by the far wall, snapping to the wrong one.
function wallPointFromEvent(e) {
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hits = _ray.intersectObjects(sceneRoot.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o) { if (o.userData?.wallId != null) return { x: h.point.x, z: h.point.z }; o = o.parent; }
  }
  return null;
}

// Where a placed/dragged item should follow the cursor: wall items point at the
// wall under the cursor (fallback to the floor point); floor items use the floor.
function placementPoint(e, type) {
  if (getItem(type)?.mount === 'wall') return wallPointFromEvent(e) || floorPointFromEvent(e);
  return floorPointFromEvent(e);
}

function worldToImage(w) {
  return { x: w.x * effectiveScale() + _offset.x, y: w.z * effectiveScale() + _offset.y };
}

// Raycast the selected item's handles; returns the handle's userData or null.
function raycastHandle(e) {
  if (!handleMeshes.length) return null;
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hits = _ray.intersectObjects(handleMeshes, false);
  return hits.length ? hits[0].object.userData.handle : null;
}

// Raycast furniture/opening bodies; returns { kind, id } or null.
function raycastBody(e) {
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hits = _ray.intersectObjects(sceneRoot.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o) {
      if (o.userData?.furnitureId != null) return { kind: 'furniture', id: o.userData.furnitureId };
      if (o.userData?.openingId != null) return { kind: 'opening', id: o.userData.openingId };
      if (o.userData?.wallId != null) return { kind: 'wall', id: o.userData.wallId };
      if (o.userData?.roomKey != null) return { kind: 'room', key: o.userData.roomKey, style: o.userData.roomStyle, x: o.userData.roomX, y: o.userData.roomY };
      o = o.parent;
    }
  }
  return null;
}

// ---- Selection handles & opening pick proxies (added to sceneRoot in rebuild) ----
function addHandle(x, y, z, data) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(HANDLE_R, 16, 12), matHandle);
  m.position.set(x, y, z);
  m.renderOrder = 999;
  m.userData.handle = data;
  sceneRoot.add(m);
  handleMeshes.push(m);
}

function buildSelectionHandles() {
  handleMeshes = [];
  const sel = state.selection;
  if (!sel) return;
  if (sel.kind === 'furniture') {
    const f = state.furniture.find(x => x.id === sel.id);
    const item = f && getItem(f.type);
    if (!item) return;
    if (item.resize !== 'stretch' && item.resize !== 'units') return; // fixed/snap: panel only
    const w = f.w ?? item.w, d = f.d ?? item.d;
    const cx = px2ft(f.x - _offset.x), cz = px2ft(f.y - _offset.y);
    const r = (f.rot || 0) * Math.PI / 180;
    const ux = Math.cos(r), uz = Math.sin(r);   // width axis (world XZ)
    const vx = -Math.sin(r), vz = Math.cos(r);  // depth axis
    // Wall items float at their mount height — put the grips on the item, not the floor.
    const y = item.mount === 'wall' ? ((f.mountH ?? item.mountH ?? 4) + item.h / 2) : 0.5;
    addHandle(cx + ux * w / 2, y, cz + uz * w / 2, { type: 'furn-resize', id: f.id, axis: 'w', sgn: 1 });
    addHandle(cx - ux * w / 2, y, cz - uz * w / 2, { type: 'furn-resize', id: f.id, axis: 'w', sgn: -1 });
    addHandle(cx + vx * d / 2, y, cz + vz * d / 2, { type: 'furn-resize', id: f.id, axis: 'd', sgn: 1 });
    addHandle(cx - vx * d / 2, y, cz - vz * d / 2, { type: 'furn-resize', id: f.id, axis: 'd', sgn: -1 });
  } else if (sel.kind === 'opening') {
    const o = state.openings.find(x => x.id === sel.id);
    const wall = o && state.walls.find(w => w.id === o.wallId);
    if (!wall) return;
    const lenFt = px2ft(wallLengthPx(wall));
    const halfT = (o.width / lenFt) / 2;
    const t1 = Math.max(0, o.t - halfT), t2 = Math.min(1, o.t + halfT);
    const y = o.type === 'door' ? DOOR_HEIGHT_FT * 0.5 : WINDOW_SILL_FT + WINDOW_HEIGHT_FT / 2;
    for (const [t, edge] of [[t1, 'left'], [t2, 'right']]) {
      const p = pointOnWall(wall, t);
      addHandle(px2ft(p.x - _offset.x), y, px2ft(p.y - _offset.y), { type: 'open-resize', id: o.id, edge });
    }
  }
}

function buildOpeningProxy(o) {
  const wall = state.walls.find(w => w.id === o.wallId);
  if (!wall) return null;
  const sel = state.selection?.kind === 'opening' && state.selection.id === o.id;
  const mat = new THREE.MeshBasicMaterial({ color: 0xff3b43, transparent: true, opacity: sel ? 0.16 : 0.0, depthWrite: false });
  const ry = -wallAngle(wall);
  const depth = WALL_THICKNESS_FT + 0.1;

  if (o.type === 'window') {
    // Windows are solid glass — the whole pane is selectable.
    const c = pointOnWall(wall, o.t);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.width, WINDOW_HEIGHT_FT, depth), mat);
    mesh.position.set(px2ft(c.x - _offset.x), WINDOW_SILL_FT + WINDOW_HEIGHT_FT / 2, px2ft(c.y - _offset.y));
    mesh.rotation.y = ry;
    mesh.userData.openingId = o.id;
    return mesh;
  }

  // Door: only the frame (jambs + header) is clickable, so the open doorway in
  // the middle doesn't grab the door when you walk through it.
  const lenFt = px2ft(wallLengthPx(wall));
  const halfT = (o.width / lenFt) / 2;
  const t1 = Math.max(0, o.t - halfT), t2 = Math.min(1, o.t + halfT);
  const group = new THREE.Group();
  group.userData.openingId = o.id;
  for (const t of [t1, t2]) {
    const p = pointOnWall(wall, t);
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.4, DOOR_HEIGHT_FT, depth), mat);
    jamb.position.set(px2ft(p.x - _offset.x), DOOR_HEIGHT_FT / 2, px2ft(p.y - _offset.y));
    jamb.rotation.y = ry;
    group.add(jamb);
  }
  const headerH = state.wallHeightFt - DOOR_HEIGHT_FT;
  if (headerH > 0.4) {
    const c = pointOnWall(wall, o.t);
    const header = new THREE.Mesh(new THREE.BoxGeometry(o.width, headerH, depth), mat);
    header.position.set(px2ft(c.x - _offset.x), DOOR_HEIGHT_FT + headerH / 2, px2ft(c.y - _offset.y));
    header.rotation.y = ry;
    group.add(header);
  }
  return group;
}

function updateGhost(type, rot, worldPt) {
  if (!worldPt) { if (ghost) ghost.group.visible = false; return; }
  if (!ghost || ghost.type !== type || ghost.rot !== rot) {
    if (ghost) scene.remove(ghost.group);
    const item = getItem(type);
    if (!item) { ghost = null; return; }
    const dims = { w: item.w, d: item.d, h: item.h, kind: item.kind, count: unitCount(item, item.w), sink: !!item.sink, dark: item.color === '#3a3d42' };
    const g = buildFurnitureGroup(dims);
    g.traverse(o => { if (o.material) o.material = ghostMat; });
    scene.add(g);
    ghost = { type, rot, group: g };
  }
  ghost.group.visible = true;
  const gi = getItem(type);
  if (gi && gi.mount === 'wall') {
    // Ride the nearest wall at mount height so you can position before dropping.
    const img = worldToImage(worldPt);
    const pose = wallSnapPose(gi, img.x, img.y);
    if (pose) {
      ghost.group.position.set(px2ft(pose.x - _offset.x), gi.mountH ?? 4, px2ft(pose.y - _offset.y));
      ghost.group.rotation.y = -pose.rot * Math.PI / 180;
      return;
    }
  }
  // Floor item: resolve the preview out of walls so it can't be positioned
  // through them (mirrors what happens on drop).
  const img = worldToImage(worldPt);
  const tmp = { type, x: img.x, y: img.y, rot, w: gi ? gi.w : 2, d: gi ? gi.d : 2 };
  resolveAgainstWalls(tmp);
  ghost.group.position.set(px2ft(tmp.x - _offset.x), 0, px2ft(tmp.y - _offset.y));
  ghost.group.rotation.y = -rot * Math.PI / 180;
}

function clearGhost() {
  if (ghost) { scene.remove(ghost.group); ghost = null; }
  lastFloorPt = null;
}

function in3dOrWalk() { return state.view === '3d' || state.view === 'walk'; }

function beginManip(m) {
  manip = m;
  orbit.enabled = false;
  suppressLook = true;
}
function endManip() {
  if (manip && (manip.kind === 'furn-move' || manip.kind === 'furn-resize')) {
    const f = state.furniture.find(x => x.id === manip.id);
    if (f) { resolveAgainstWalls(f); emit(); }
  }
  manip = null;
  orbit.enabled = state.view === '3d'; // keep orbit OFF in walk
  suppressLook = false;
}

function applyManip(wp) {
  if (manip.kind === 'furn-move') {
    const f = state.furniture.find(x => x.id === manip.id);
    if (f) { const img = worldToImage(wp); f.x = img.x - manip.offx; f.y = img.y - manip.offy; resolveAgainstWalls(f); emit(); }
  } else if (manip.kind === 'furn-resize') {
    const f = state.furniture.find(x => x.id === manip.id);
    if (!f) return;
    const item = getItem(f.type);
    const { axis, sgn, ux, uy, anchor } = manip;
    const img = worldToImage(wp); // cursor in image px (anchor lives in image px)
    // Extent = distance from the fixed (opposite) edge to the cursor, along axis.
    const extentPx = ((img.x - anchor.x) * ux + (img.y - anchor.y) * uy) * sgn;
    const valueFt = Math.max(0, extentPx) / effectiveScale();
    const next = applyResize(item, axis, valueFt, { w: f.w, d: f.d });
    f.w = next.w; f.d = next.d;
    // Recenter so the anchored edge stays put (only the dragged side moved).
    const halfPx = ((axis === 'w' ? next.w : next.d) * effectiveScale()) / 2;
    f.x = anchor.x + sgn * halfPx * ux;
    f.y = anchor.y + sgn * halfPx * uy;
    emit();
  } else if (manip.kind === 'open-move' || manip.kind === 'open-resize') {
    const o = state.openings.find(x => x.id === manip.id);
    const wall = o && state.walls.find(w => w.id === o.wallId);
    if (!wall) return;
    const img = worldToImage(wp);
    const proj = projectPointToSegment(img.x, img.y, wall.x1, wall.y1, wall.x2, wall.y2);
    const len = wallLengthPx(wall);
    const pxPerFt = state.scale ?? PX_PER_FT_FALLBACK;
    if (manip.kind === 'open-move') {
      const half = ((o.width * pxPerFt) / len) / 2;
      o.t = Math.max(half, Math.min(1 - half, proj.t));
    } else {
      const oldHalfT = ((o.width * pxPerFt) / len) / 2;
      const fixedT = manip.edge === 'left' ? (o.t + oldHalfT) : (o.t - oldHalfT);
      const movedT = Math.max(0, Math.min(1, proj.t));
      const newWidthPx = Math.abs(movedT - fixedT) * len;
      const newFt = Math.max(1, Math.min(12, newWidthPx / pxPerFt));
      const newHalfT = ((newFt * pxPerFt) / len) / 2;
      o.width = newFt;
      o.t = manip.edge === 'left' ? fixedT - newHalfT : fixedT + newHalfT;
      o.t = Math.max(newHalfT, Math.min(1 - newHalfT, o.t));
    }
    emit();
  }
}

// Capture-phase pointerdown beats OrbitControls so we can intercept grabs.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !in3dOrWalk()) return;
  downXY = { x: e.clientX, y: e.clientY };
  if (state.tool === 'furniture' && state.placingFurniture) return; // drop on click (pointerup)
  if (state.tool !== 'pan' && state.tool !== 'select') return;

  // 1. Grab a resize handle on the selected item.
  const h = raycastHandle(e);
  if (h) {
    if (h.type === 'furn-resize') {
      const f = state.furniture.find(x => x.id === h.id);
      const item = f && getItem(f.type);
      const a = (f.rot || 0) * Math.PI / 180;
      const ux = h.axis === 'w' ? Math.cos(a) : -Math.sin(a);
      const uy = h.axis === 'w' ? Math.sin(a) : Math.cos(a);
      const halfPx = ((h.axis === 'w' ? (f.w ?? item.w) : (f.d ?? item.d)) * effectiveScale()) / 2;
      const anchor = { x: f.x - h.sgn * halfPx * ux, y: f.y - h.sgn * halfPx * uy };
      beginManip({ kind: 'furn-resize', id: h.id, axis: h.axis, sgn: h.sgn, ux, uy, anchor });
    }
    else if (h.type === 'open-resize') beginManip({ kind: 'open-resize', id: h.id, edge: h.edge });
    e.stopImmediatePropagation(); e.preventDefault();
    return;
  }
  // 2. Grab a DRAGGABLE body (furniture / opening) → select + move. Walls and
  //    room floors aren't draggable: they're click-selected on pointerup, so we
  //    leave the event for OrbitControls (a drag still orbits the scene).
  const body = raycastBody(e);
  if (body && (body.kind === 'furniture' || body.kind === 'opening')) {
    state.selection = { kind: body.kind, id: body.id };
    if (body.kind === 'furniture') {
      const f = state.furniture.find(x => x.id === body.id);
      const wallItem = getItem(f.type)?.mount === 'wall';
      const wp = floorPointFromEvent(e); const img = wp ? worldToImage(wp) : { x: f.x, y: f.y };
      // Wall items snap to the nearest wall, so track the cursor directly — the
      // floor-plane grab offset is meaningless for an item floating at height.
      beginManip({ kind: 'furn-move', id: body.id, offx: wallItem ? 0 : img.x - f.x, offy: wallItem ? 0 : img.y - f.y });
    } else {
      beginManip({ kind: 'open-move', id: body.id });
    }
    emit();
    e.stopImmediatePropagation(); e.preventDefault();
  }
}, true);

document.addEventListener('pointermove', (e) => {
  if (!in3dOrWalk()) return;
  if (manip) {
    // Moving a wall item: point at the wall under the cursor, not its floor spot.
    let wp = null;
    if (manip.kind === 'furn-move') {
      const f = state.furniture.find(x => x.id === manip.id);
      if (f && getItem(f.type)?.mount === 'wall') wp = wallPointFromEvent(e);
    }
    if (!wp) wp = floorPointFromEvent(e);
    if (wp) applyManip(wp);
    return;
  }
  if (state.tool === 'furniture' && state.placingFurniture) {
    lastFloorPt = placementPoint(e, state.placingFurniture);
    updateGhost(state.placingFurniture, state.placingRot, lastFloorPt);
  }
});

document.addEventListener('pointerup', (e) => {
  if (manip) { endManip(); downXY = null; return; }
  if (!downXY || !in3dOrWalk()) { downXY = null; return; }
  const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
  downXY = null;
  if (moved >= 6) return; // it was a drag (orbit / look), not a click
  if (state.tool === 'furniture' && state.placingFurniture) {
    const wp = placementPoint(e, state.placingFurniture);
    if (wp) {
      const img = worldToImage(wp);
      const f = addFurniture(state.placingFurniture, img.x, img.y, state.placingRot);
      fitBetweenWalls(f);
      state.placingFurniture = null;
      state.tool = 'pan';
      state.selection = { kind: 'furniture', id: f.id };
      emit();
    }
  } else if (state.tool === 'pan' || state.tool === 'select') {
    // Click selects walls / room floors (not draggable, so handled here on the
    // click); furniture/openings were already grabbed on pointerdown. Empty → deselect.
    const body = raycastBody(e);
    if (body && (body.kind === 'wall' || body.kind === 'room')) {
      state.selection = body.kind === 'wall'
        ? { kind: 'wall', id: body.id }
        : { kind: 'room', key: body.key, style: body.style, x: body.x, y: body.y };
      emit();
    } else if (!body && state.selection) {
      state.selection = null; emit();
    }
  }
});

function buildWallSegments(wall, openings, wallHeight) {
  const lenFt = px2ft(wallLengthPx(wall));
  const intervals = openings
    .map(o => {
      const halfT = (o.width / lenFt) / 2;
      return { o, t1: Math.max(0, o.t - halfT), t2: Math.min(1, o.t + halfT) };
    })
    .sort((a, b) => a.t1 - b.t1);

  const segments = [];
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.t1 > cursor + 1e-6) {
      segments.push({ t1: cursor, t2: iv.t1, yBottom: 0, yTop: wallHeight });
    }
    cursor = Math.max(cursor, iv.t2);
    // above/below opening pieces
    if (iv.o.type === 'door') {
      if (DOOR_HEIGHT_FT < wallHeight) {
        segments.push({ t1: iv.t1, t2: iv.t2, yBottom: DOOR_HEIGHT_FT, yTop: wallHeight });
      }
    } else {
      // window
      if (WINDOW_SILL_FT > 0) {
        segments.push({ t1: iv.t1, t2: iv.t2, yBottom: 0, yTop: WINDOW_SILL_FT });
      }
      const headTop = Math.min(wallHeight, WINDOW_SILL_FT + WINDOW_HEIGHT_FT);
      if (headTop < wallHeight) {
        segments.push({ t1: iv.t1, t2: iv.t2, yBottom: headTop, yTop: wallHeight });
      }
    }
  }
  if (cursor < 1 - 1e-6) {
    segments.push({ t1: cursor, t2: 1, yBottom: 0, yTop: wallHeight });
  }
  return segments;
}

function _mid(wall, t) {
  return {
    x: wall.x1 + (wall.x2 - wall.x1) * t,
    y: wall.y1 + (wall.y2 - wall.y1) * t,
  };
}

function buildWallSegmentMesh(wall, seg) {
  const a = _mid(wall, seg.t1);
  const b = _mid(wall, seg.t2);
  const lenFt = px2ft(dist(a.x, a.y, b.x, b.y));
  if (lenFt < 0.01) return null;
  const h = seg.yTop - seg.yBottom;
  if (h < 0.01) return null;
  const geo = new THREE.BoxGeometry(lenFt, h, WALL_THICKNESS_FT);
  const mesh = new THREE.Mesh(geo, wallMat(wall));
  mesh.userData.wallId = wall.id; // selectable in 3D
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const cx = px2ft((a.x + b.x) / 2 - _offset.x);
  const cz = px2ft((a.y + b.y) / 2 - _offset.y);
  const cy = (seg.yBottom + seg.yTop) / 2;
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
  return mesh;
}

function buildWindowPane(wall, o) {
  const lenFt = px2ft(wallLengthPx(wall));
  const halfT = (o.width / lenFt) / 2;
  const t1 = Math.max(0, o.t - halfT);
  const t2 = Math.min(1, o.t + halfT);
  const a = _mid(wall, t1);
  const b = _mid(wall, t2);
  const widthFt = px2ft(dist(a.x, a.y, b.x, b.y));
  const heightFt = WINDOW_HEIGHT_FT;
  const geo = new THREE.BoxGeometry(widthFt - 0.1, heightFt - 0.1, 0.05);
  const mesh = new THREE.Mesh(geo, matWindow);
  const cx = px2ft((a.x + b.x) / 2 - _offset.x);
  const cz = px2ft((a.y + b.y) / 2 - _offset.y);
  mesh.position.set(cx, WINDOW_SILL_FT + heightFt / 2, cz);
  mesh.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
  return mesh;
}

function buildDoorJamb(wall, o) {
  // Simple slim frame as a group of thin boxes around the opening.
  const group = new THREE.Group();
  const lenFt = px2ft(wallLengthPx(wall));
  const halfT = (o.width / lenFt) / 2;
  const t1 = Math.max(0, o.t - halfT);
  const t2 = Math.min(1, o.t + halfT);
  const a = _mid(wall, t1);
  const b = _mid(wall, t2);
  const widthFt = px2ft(dist(a.x, a.y, b.x, b.y));
  const jambT = 0.15;
  const sideGeo = new THREE.BoxGeometry(jambT, DOOR_HEIGHT_FT, WALL_THICKNESS_FT + 0.05);
  const left = new THREE.Mesh(sideGeo, matDoorJamb);
  const right = new THREE.Mesh(sideGeo, matDoorJamb);
  left.position.set(-widthFt / 2 + jambT / 2, DOOR_HEIGHT_FT / 2, 0);
  right.position.set(widthFt / 2 - jambT / 2, DOOR_HEIGHT_FT / 2, 0);
  group.add(left, right);
  const cx = px2ft((a.x + b.x) / 2 - _offset.x);
  const cz = px2ft((a.y + b.y) / 2 - _offset.y);
  group.position.set(cx, 0, cz);
  group.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
  return group;
}

// ---------- Walk mode (custom first-person controls) ----------

const EYE_HEIGHT_FT = 5 + 9 / 12; // 5'9"
const MOUSE_SENSITIVITY = 0.004;   // rad per pixel while click-dragging to look
const MAX_DELTA_PX = 140;          // clamp per-event movement against spikes
const MAX_PITCH = Math.PI / 2 - 0.05;

// Walk mode uses click-and-drag to look (no pointer lock) so the cursor stays
// free for clicking UI and, later, placing furniture. Hold left mouse button
// and drag to rotate; WASD/arrows move; release to free the cursor.
const walk = {
  dragging: false,
  yaw: 0,
  pitch: 0,
  keys: { forward: false, back: false, left: false, right: false, turnL: false, turnR: false },
  speed: 5.5, // feet/sec
  turnSpeed: 1.9, // rad/sec for Q/E
};

camera.rotation.order = 'YXZ';
const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function applyCameraRotation() {
  _lookEuler.set(walk.pitch, walk.yaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(_lookEuler);
}

function clampDelta(v) {
  return Math.max(-MAX_DELTA_PX, Math.min(MAX_DELTA_PX, v || 0));
}

function onMouseDown(e) {
  if (state.view !== 'walk' || e.button !== 0) return;
  if (manip) return; // grabbing a handle/item — don't start look-drag
  walk.dragging = true;
  renderer.domElement.style.cursor = 'grabbing';
  e.preventDefault();
}

function onMouseMove(e) {
  if (state.view !== 'walk' || !walk.dragging) return;
  const mx = clampDelta(e.movementX);
  const my = clampDelta(e.movementY);
  walk.yaw -= mx * MOUSE_SENSITIVITY;
  walk.pitch -= my * MOUSE_SENSITIVITY;
  walk.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, walk.pitch));
  applyCameraRotation();
}

function onMouseUp() {
  if (!walk.dragging) return;
  walk.dragging = false;
  renderer.domElement.style.cursor = state.view === 'walk' ? 'grab' : '';
}

renderer.domElement.addEventListener('mousedown', onMouseDown);
document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mouseup', onMouseUp);

function updateHud() {
  document.getElementById('walk-hud').hidden = state.view !== 'walk';
  document.getElementById('walk-paused').hidden = true;
}

function onKeyDown(e) {
  if (state.view !== 'walk') return;
  switch (e.code) {
    case 'ArrowUp': case 'KeyW': walk.keys.forward = true; break;
    case 'ArrowDown': case 'KeyS': walk.keys.back = true; break;
    case 'ArrowLeft': case 'KeyA': walk.keys.left = true; break;
    case 'ArrowRight': case 'KeyD': walk.keys.right = true; break;
    case 'KeyQ': walk.keys.turnL = true; break;
    case 'KeyE': walk.keys.turnR = true; break;
  }
}
function onKeyUp(e) {
  switch (e.code) {
    case 'ArrowUp': case 'KeyW': walk.keys.forward = false; break;
    case 'ArrowDown': case 'KeyS': walk.keys.back = false; break;
    case 'ArrowLeft': case 'KeyA': walk.keys.left = false; break;
    case 'ArrowRight': case 'KeyD': walk.keys.right = false; break;
    case 'KeyQ': walk.keys.turnL = false; break;
    case 'KeyE': walk.keys.turnR = false; break;
  }
}
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

export function enterWalk() {
  computeOffset();
  camera.position.set(0, EYE_HEIGHT_FT, 0);
  walk.yaw = 0;
  walk.pitch = 0;
  walk.dragging = false;
  applyCameraRotation();
  camera.fov = WALK_FOV;
  camera.updateProjectionMatrix();
  orbit.enabled = false;
  renderer.domElement.style.cursor = 'grab';
  updateHud();
}

export function exitWalk() {
  walk.dragging = false;
  walk.keys.forward = walk.keys.back = walk.keys.left = walk.keys.right = false;
  camera.fov = ORBIT_FOV;
  camera.updateProjectionMatrix();
  orbit.enabled = true;
  renderer.domElement.style.cursor = '';
  updateHud();
}

// Wall collision: keep camera at least PLAYER_RADIUS from any wall segment.
const PLAYER_RADIUS = 0.6;
function collideAndMove(prev, next) {
  // Build wall segments list (in feet) cached per rebuild.
  const segs = collisionSegments;
  // try full move first; if collides, try x-only then z-only
  const tries = [
    { x: next.x, z: next.z },
    { x: next.x, z: prev.z },
    { x: prev.x, z: next.z },
  ];
  for (const t of tries) {
    if (!collidesAt(t.x, t.z, segs)) return t;
  }
  return { x: prev.x, z: prev.z };
}

let collisionSegments = [];
function addCollisionPart(w, t1, t2) {
  const ax = w.x1 + (w.x2 - w.x1) * t1;
  const ay = w.y1 + (w.y2 - w.y1) * t1;
  const bx = w.x1 + (w.x2 - w.x1) * t2;
  const by = w.y1 + (w.y2 - w.y1) * t2;
  collisionSegments.push({
    ax: px2ft(ax - _offset.x), az: px2ft(ay - _offset.y),
    bx: px2ft(bx - _offset.x), bz: px2ft(by - _offset.y),
  });
}
let collisionFurniture = [];
function rebuildCollision() {
  collisionSegments = [];
  for (const w of state.walls) {
    const lenFt = px2ft(wallLengthPx(w));
    // Only doors are walkable; windows still block.
    const doors = state.openings
      .filter(o => o.wallId === w.id && o.type === 'door')
      .map(o => {
        const halfT = (o.width / lenFt) / 2;
        return { t1: Math.max(0, o.t - halfT), t2: Math.min(1, o.t + halfT) };
      })
      .sort((a, b) => a.t1 - b.t1);
    let cursor = 0;
    for (const d of doors) {
      if (d.t1 > cursor) addCollisionPart(w, cursor, d.t1);
      cursor = Math.max(cursor, d.t2);
    }
    if (cursor < 1) addCollisionPart(w, cursor, 1);
  }
  // Placed furniture are solid obstacles (rotated rectangles, in feet). Wall-
  // mounted items are elevated, so you walk under/past them — skip those.
  collisionFurniture = state.furniture
    .filter(f => getItem(f.type)?.mount !== 'wall')
    .map(f => {
      const item = getItem(f.type);
      const w = f.w ?? (item ? item.w : 2), d = f.d ?? (item ? item.d : 2);
      return {
        cx: px2ft(f.x - _offset.x), cz: px2ft(f.y - _offset.y),
        hw: w / 2, hd: d / 2, a: -(f.rot || 0) * Math.PI / 180,
      };
    });
}

function distPointSeg2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, z = az + t * dz;
  return Math.hypot(px - x, pz - z);
}

function collidesAt(x, z, segs) {
  for (const s of segs) {
    if (distPointSeg2D(x, z, s.ax, s.az, s.bx, s.bz) < PLAYER_RADIUS + WALL_THICKNESS_FT / 2) {
      return true;
    }
  }
  // Furniture: transform the player into each item's local frame and test the
  // rectangle expanded by the player radius.
  for (const o of collisionFurniture) {
    const dx = x - o.cx, dz = z - o.cz;
    const lx = dx * Math.cos(o.a) - dz * Math.sin(o.a);
    const lz = dx * Math.sin(o.a) + dz * Math.cos(o.a);
    if (Math.abs(lx) < o.hw + PLAYER_RADIUS && Math.abs(lz) < o.hd + PLAYER_RADIUS) {
      return true;
    }
  }
  return false;
}

// Animation loop
let lastT = performance.now();
function animate(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  requestAnimationFrame(animate);

  if (state.view === 'walk') {
    // Q/E turn the view
    const turn = (walk.keys.turnR ? 1 : 0) - (walk.keys.turnL ? 1 : 0);
    if (turn !== 0) { walk.yaw -= turn * walk.turnSpeed * dt; applyCameraRotation(); }
    const fwd = (walk.keys.forward ? 1 : 0) - (walk.keys.back ? 1 : 0);
    const strafe = (walk.keys.right ? 1 : 0) - (walk.keys.left ? 1 : 0);
    if (fwd !== 0 || strafe !== 0) {
      // Forward (camera looks down -Z when yaw=0). Yaw rotates about +Y.
      const sin = Math.sin(walk.yaw), cos = Math.cos(walk.yaw);
      const stepF = fwd * walk.speed * dt;
      const stepS = strafe * walk.speed * dt;
      const dx = -sin * stepF + cos * stepS;
      const dz = -cos * stepF - sin * stepS;
      const prev = { x: camera.position.x, z: camera.position.z };
      const next = { x: prev.x + dx, z: prev.z + dz };
      const corrected = collideAndMove(prev, next);
      camera.position.x = corrected.x;
      camera.position.z = corrected.z;
      camera.position.y = EYE_HEIGHT_FT;
    }
  } else if (state.view === '3d') {
    orbit.update();
  }
  if (state.view === '3d' || state.view === 'walk') {
    renderer.render(scene, camera);
  }
}
requestAnimationFrame(animate);

export function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Frame the camera over the walls when entering 3D
export function frameOrbit() {
  const bb = wallsBoundingBox(state.walls);
  if (!bb) {
    camera.position.set(30, 30, 30);
    camera.lookAt(0, 0, 0);
    orbit.target.set(0, 0, 0);
    return;
  }
  const wFt = px2ft(bb.w), hFt = px2ft(bb.h);
  const span = Math.max(wFt, hFt);
  const dist = span * 1.4 + 20;
  camera.position.set(dist * 0.7, dist * 0.9, dist * 0.7);
  orbit.target.set(0, state.wallHeightFt / 2, 0);
  camera.lookAt(orbit.target);
}

// Rebuild scene when state changes.
subscribe(() => {
  rebuild();
  rebuildCollision();
  updateHud();
  // Keep the placement ghost in sync (e.g. rotation via R key).
  if (in3dOrWalk() && state.tool === 'furniture' && state.placingFurniture) {
    if (lastFloorPt) updateGhost(state.placingFurniture, state.placingRot, lastFloorPt);
  } else {
    clearGhost();
  }
});
