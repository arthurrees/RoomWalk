// 3D view: build scene from state, OrbitControls + click-drag walk mode.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, subscribe, emit, addFurniture } from './state.js';
import {
  dist, wallLengthPx, wallsBoundingBox, PX_PER_FT_FALLBACK,
  DOOR_HEIGHT_FT, WINDOW_SILL_FT, WINDOW_HEIGHT_FT,
} from './geom.js';
import { getItem, unitCount } from './furniture.js';
import { resolveAgainstWalls, recomputeClips } from './collision.js';

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
const matFloor = new THREE.MeshStandardMaterial({ color: 0x6b5e4b, roughness: 0.9 });
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

// Build the scene from current state.
export function rebuild() {
  computeOffset();
  while (sceneRoot.children.length) {
    const c = sceneRoot.children.pop();
    c.traverse?.(o => { o.geometry?.dispose?.(); });
  }

  if (state.furniture.length) recomputeClips();
  if (state.walls.length === 0 && state.furniture.length === 0) return;

  if (state.walls.length > 0) {
    const bb = wallsBoundingBox(state.walls);
    const floorW = px2ft(bb.w) + 8;
    const floorH = px2ft(bb.h) + 8;

    // Floor
    const floorGeo = new THREE.PlaneGeometry(floorW, floorH);
    const floor = new THREE.Mesh(floorGeo, matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    sceneRoot.add(floor);

    // Grid helper for orientation
    const grid = new THREE.GridHelper(Math.max(floorW, floorH), Math.round(Math.max(floorW, floorH)));
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

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
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
      const tankD = d * 0.3;
      g.add(box(w, h * 0.7, tankD, matFurnCeramic, 0, h * 0.35, -d / 2 + tankD / 2)); // tank
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.5, w * 0.45, h * 0.4, 18), matFurnCeramic);
      bowl.position.set(0, h * 0.2, d * 0.12); bowl.castShadow = true; g.add(bowl);
      break;
    }
    case 'sink': {
      g.add(box(w, h * 0.85, d, matFurnWood, 0, h * 0.85 / 2, 0));           // vanity cabinet
      g.add(box(w, h * 0.15, d, matFurnCeramic, 0, h * 0.85 + h * 0.075, 0)); // basin top
      // one recessed basin per unit
      const bw = (w / count) * 0.6;
      for (let i = 0; i < count; i++) {
        const cx = -w / 2 + (i + 0.5) * (w / count);
        g.add(box(bw, h * 0.06, d * 0.6, matFurnDark, cx, h * 0.86, 0));
      }
      break;
    }
    case 'tub': {
      g.add(box(w, h, d, matFurnCeramic, 0, h / 2, 0));
      g.add(box(w * 0.88, h * 0.5, d * 0.78, matFurnDark, 0, h * 0.6, 0));    // recessed basin
      break;
    }
    case 'stove': {
      g.add(box(w, h * 0.9, d, matFurnAppliance, 0, h * 0.45, 0));           // body
      g.add(box(w * 0.96, h * 0.06, d * 0.96, matFurnDark, 0, h * 0.93, 0)); // cooktop
      break;
    }
    case 'counter': {
      g.add(box(w, h * 0.92, d, matFurnWood, 0, h * 0.46, 0));               // cabinet
      g.add(box(w, h * 0.08, d, matFurnCounter, 0, h * 0.96, 0));            // countertop
      // cabinet-bay seams
      for (let i = 1; i < count; i++) {
        const sx = -w / 2 + i * (w / count);
        g.add(box(0.04, h * 0.9, d, matFurnDark, sx, h * 0.46, 0));
      }
      if (dims.sink) {
        const bw = (w / count) * 0.6;
        for (let i = 0; i < count; i++) {
          const cx = -w / 2 + (i + 0.5) * (w / count);
          g.add(box(bw, h * 0.06, d * 0.6, matFurnDark, cx, h * 0.97, 0)); // sink basin per bay
        }
      }
      break;
    }
    case 'appliance':
      g.add(box(w, h, d, matFurnAppliance, 0, h / 2, 0));
      break;
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
  g.position.set(px2ft(f.x - _offset.x), 0, px2ft(f.y - _offset.y));
  g.rotation.y = -(f.rot || 0) * Math.PI / 180;
  return g;
}

// ---- 3D furniture placement & move ----
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPt = new THREE.Vector3();
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffd2d4, transparent: true, opacity: 0.45, depthWrite: false });

let ghost = null;          // { type, rot, group }
let lastFloorPt = null;    // last world point under cursor on the floor
let furnDrag = null;       // { id } while dragging an existing item (orbit view)
let downXY = null;         // screen pos at pointerdown (click-vs-drag detection)

function ndcFromEvent(e) {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  return _ndc;
}

// World floor point under the cursor, or null.
function floorPointFromEvent(e) {
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hit = _ray.ray.intersectPlane(_floorPlane, _hitPt);
  return hit ? { x: hit.x, z: hit.z } : null;
}

// Convert a world floor point (feet) back to image-pixel coords.
function worldToImage(w) {
  return { x: w.x * effectiveScale() + _offset.x, y: w.z * effectiveScale() + _offset.y };
}

function pickFurnitureId(e) {
  _ray.setFromCamera(ndcFromEvent(e), camera);
  const hits = _ray.intersectObjects(sceneRoot.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o) { if (o.userData && o.userData.furnitureId != null) return o.userData.furnitureId; o = o.parent; }
  }
  return null;
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
  ghost.group.position.set(worldPt.x, 0, worldPt.z);
  ghost.group.rotation.y = -rot * Math.PI / 180;
}

function clearGhost() {
  if (ghost) { scene.remove(ghost.group); ghost = null; }
  lastFloorPt = null;
}

function in3dOrWalk() { return state.view === '3d' || state.view === 'walk'; }

// Capture-phase pointerdown beats OrbitControls so we can intercept grabs.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !in3dOrWalk()) return;
  downXY = { x: e.clientX, y: e.clientY };
  if (state.tool === 'furniture' && state.placingFurniture) return; // drop on click (pointerup)
  // Drag an existing item to move it — orbit view only (walk uses drag to look).
  if (state.view === '3d' && (state.tool === 'pan' || state.tool === 'select')) {
    const id = pickFurnitureId(e);
    if (id != null) {
      state.selection = { kind: 'furniture', id };
      emit();
      furnDrag = { id };
      orbit.enabled = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }
}, true);

document.addEventListener('pointermove', (e) => {
  if (!in3dOrWalk()) return;
  if (furnDrag) {
    const wp = floorPointFromEvent(e);
    if (wp) {
      const f = state.furniture.find(x => x.id === furnDrag.id);
      if (f) { const img = worldToImage(wp); f.x = img.x; f.y = img.y; emit(); }
    }
    return;
  }
  if (state.tool === 'furniture' && state.placingFurniture) {
    lastFloorPt = floorPointFromEvent(e);
    updateGhost(state.placingFurniture, state.placingRot, lastFloorPt);
  }
});

document.addEventListener('pointerup', (e) => {
  if (furnDrag) {
    const f = state.furniture.find(x => x.id === furnDrag.id);
    if (f) { resolveAgainstWalls(f); emit(); }
    furnDrag = null; orbit.enabled = true; downXY = null;
    return;
  }
  if (!downXY || !in3dOrWalk()) { downXY = null; return; }
  const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
  downXY = null;
  if (moved >= 6) return; // it was a drag (orbit / look), not a click
  if (state.tool === 'furniture' && state.placingFurniture) {
    const wp = floorPointFromEvent(e);
    if (wp) {
      const img = worldToImage(wp);
      const f = addFurniture(state.placingFurniture, img.x, img.y, state.placingRot);
      resolveAgainstWalls(f);
      emit();
    }
  } else if (state.tool === 'pan' || state.tool === 'select') {
    const id = pickFurnitureId(e);
    if (id != null) { state.selection = { kind: 'furniture', id }; emit(); }
    else if (state.selection?.kind === 'furniture') { state.selection = null; emit(); }
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
  const mesh = new THREE.Mesh(geo, matWall);
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
  // Placed furniture are solid obstacles (rotated rectangles, in feet).
  collisionFurniture = state.furniture.map(f => {
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
