// 2D canvas: floor plan image + wall/door/window editor.
import { state, emit, addWall, addOpening, addFurniture, deleteSelection, subscribe } from './state.js';
import {
  dist, projectPointToSegment, nearestWall, snapToEndpoint, snapToAxis, findGap,
  pointOnWall, wallAngle, wallLengthPx, PX_PER_FT_FALLBACK,
  DEFAULT_DOOR_WIDTH_FT, DEFAULT_WINDOW_WIDTH_FT, formatLength,
} from './geom.js';
import { getItem, unitCount, applyResize, sizeNote } from './furniture.js';
import { resolveAgainstWalls, fitBetweenWalls, recomputeClips, wallSnapPose } from './collision.js';
import { detectDebug } from './detect.js';

// Warm architectural-desk palette shared with the redesigned application shell.
const PAL = {
  canvasBg: '#f7f5ef',
  grid: 'rgba(42,70,61,0.08)',
  wall: '#40564e',
  wallSel: '#df725b',
  node: '#287f6a',
  draft: '#287f6a',
  draftEnd: '#df725b',
  door: '#b47a52',
  doorSel: '#df725b',
  window: '#5b7da6',
  windowSel: '#3f6798',
  handle: '#df725b',
  accentFill: 'rgba(40,127,106,0.94)',
  accentStroke: 'rgba(40,127,106,0.72)',
  scalePick: '#d9a33f',
  furnFill: 'rgba(103,121,113,0.20)',
  furnStroke: '#71867d',
  wallMountStroke: '#287f6a',
  furnLabel: '#344942',
  furnSel: '#df725b',
  furnGhost: 'rgba(102,121,114,0.35)',
  warn: '#c95446',
  glow: 'rgba(40,127,106,0.30)',
};

const SNAP_PX = 12;            // endpoint snap radius (screen px)
const AXIS_SNAP_DEG = 10;      // straighten a draft wall to H/V within this many degrees
const WALL_HIT_PX = 8;         // wall click hit-test radius
const HANDLE_PX = 10;          // resize-handle visual size (screen px)
const HANDLE_HIT_PAD = 6;      // extra hit padding around handles
const EDGE_GRAB_FRAC = 0.28;   // fraction of opening length at each end that resizes

const canvas = document.getElementById('canvas2d');
const ctx = canvas.getContext('2d');

let dpr = window.devicePixelRatio || 1;
let mouse = { x: 0, y: 0, world: { x: 0, y: 0 }, down: false, downStart: null, downBtn: 0 };
let dragging = null; // { kind, id, mode, ... }

// Convert screen px <-> world px using pan/zoom.
function s2w(sx, sy) {
  return { x: (sx - state.pan.x) / state.zoom, y: (sy - state.pan.y) / state.zoom };
}
function w2s(wx, wy) {
  return { x: wx * state.zoom + state.pan.x, y: wy * state.zoom + state.pan.y };
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  draw();
}

window.addEventListener('resize', resize);

// Build a clean reference-line version of the uploaded plan: dark pixels (wall
// lines, text, symbols) become graphite; light background becomes transparent.
// Returns an offscreen canvas the same size as the source image.
export function buildOutline(img, threshold = 120) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  let data;
  try {
    data = cx.getImageData(0, 0, w, h);
  } catch (e) {
    // Tainted canvas (cross-origin) — fall back to raw image.
    return null;
  }
  const px = data.data;
  // Edge color: subdued green graphite on the warm canvas.
  const R = 90, G = 109, B = 101;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (lum < threshold) {
      // Darker line → more opaque; map luminance to alpha.
      const a = Math.round(255 * (1 - lum / threshold));
      px[i] = R; px[i + 1] = G; px[i + 2] = B;
      px[i + 3] = Math.max(150, a);
    } else {
      px[i + 3] = 0;
    }
  }
  cx.putImageData(data, 0, 0);
  return c;
}

// Fit the image into view initially.
export function fitImage() {
  const rect = canvas.getBoundingClientRect();
  if (!state.image) {
    state.pan = { x: rect.width / 2, y: rect.height / 2 };
    state.zoom = 1;
    return;
  }
  const padding = 40;
  const sx = (rect.width - padding * 2) / state.image.w;
  const sy = (rect.height - padding * 2) / state.image.h;
  state.zoom = Math.min(sx, sy);
  state.pan = {
    x: (rect.width - state.image.w * state.zoom) / 2,
    y: (rect.height - state.image.h * state.zoom) / 2,
  };
}

// Draw entrypoint.
export function draw() {
  if (state.furniture.length) recomputeClips();
  const rect = canvas.getBoundingClientRect();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Background grid (light)
  drawGrid(rect);

  // Apply pan/zoom.
  ctx.save();
  ctx.translate(state.pan.x, state.pan.y);
  ctx.scale(state.zoom, state.zoom);

  // Build-from-scratch: a 1-ft world grid to draw rooms against.
  drawWorldGrid(rect);

  // Image — either the processed glowing outline or the raw upload.
  if (state.image) {
    ctx.globalAlpha = state.imageOpacity;
    if (state.outlineMode && state.image.outline) {
      // Crisp graphite lines, no glow — clean technical reference.
      ctx.drawImage(state.image.outline, 0, 0, state.image.w, state.image.h);
    } else {
      ctx.drawImage(state.image.el, 0, 0, state.image.w, state.image.h);
    }
    ctx.globalAlpha = 1;
  }

  // Walls — Foundry blue strokes with a faint matching glow.
  ctx.lineCap = 'round';
  ctx.save();
  ctx.shadowColor = PAL.glow;
  ctx.shadowBlur = 3;
  for (const w of state.walls) {
    const isSel = state.selection?.kind === 'wall' && state.selection.id === w.id;
    ctx.globalAlpha = w.hidden ? 0.22 : 1; // hidden walls stay faintly visible/selectable in 2D
    ctx.lineWidth = (isSel ? 6 : 4.5) / state.zoom;
    ctx.strokeStyle = isSel ? PAL.wallSel : PAL.wall;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
  }
  ctx.restore();

  // Endpoint dots
  for (const w of state.walls) {
    ctx.globalAlpha = w.hidden ? 0.22 : 1;
    drawWorldDot(w.x1, w.y1, 3 / state.zoom, PAL.node);
    drawWorldDot(w.x2, w.y2, 3 / state.zoom, PAL.node);
  }
  ctx.globalAlpha = 1;

  // Grab handles on the selected wall's endpoints (draggable corners).
  if (state.selection?.kind === 'wall') {
    const sw = state.walls.find(w => w.id === state.selection.id);
    if (sw && !sw.bridge) {
      for (const [hx, hy] of [[sw.x1, sw.y1], [sw.x2, sw.y2]]) {
        drawWorldDot(hx, hy, (HANDLE_PX + 1) / state.zoom, PAL.handle);
        drawWorldDot(hx, hy, (HANDLE_PX - 3) / state.zoom, PAL.canvasBg);
      }
    }
  }

  // In-progress wall
  if (state.draftWallStart) {
    const start = state.draftWallStart;
    const end = currentDraftWallEnd();
    if (end) {
      ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
      ctx.lineWidth = 4 / state.zoom;
      ctx.strokeStyle = PAL.draft;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawWorldDot(start.x, start.y, 4 / state.zoom, PAL.draft);
      drawWorldDot(end.x, end.y, 4 / state.zoom, PAL.draftEnd);
      // length label
      if (state.scale) {
        const lenFt = dist(start.x, start.y, end.x, end.y) / state.scale;
        drawLengthLabel((start.x + end.x) / 2, (start.y + end.y) / 2, formatLength(lenFt, state.units));
      }
    }
  }

  // Scale-calibration pick line (snaps onto drawn lines, then to H/V axis)
  if (state.scalePick) {
    const { p1, p2 } = state.scalePick;
    const end = p2 || scaleEndPoint(p1, mouse.world.x, mouse.world.y);
    ctx.save();
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = PAL.scalePick;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // end ticks
    for (const pt of [p1, end]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4 / state.zoom, 0, Math.PI * 2);
      ctx.fillStyle = PAL.scalePick;
      ctx.fill();
    }
    ctx.restore();
    const lenPx = dist(p1.x, p1.y, end.x, end.y);
    drawLengthLabel((p1.x + end.x) / 2, (p1.y + end.y) / 2,
      state.scale ? formatLength(lenPx / state.scale, state.units) : `${Math.round(lenPx)} px`);
  }

  // Openings
  for (const o of state.openings) {
    drawOpening(o);
  }

  // Furniture footprints
  for (const f of state.furniture) {
    drawFurniture(f);
  }

  // Furniture placement ghost
  if (state.tool === 'furniture' && state.placingFurniture) {
    drawFurnitureGhost(state.placingFurniture, mouse.world.x, mouse.world.y, state.placingRot);
  }

  // Hover preview for door/window placement
  if (state.hover && (state.tool === 'door' || state.tool === 'window')) {
    drawOpeningPreview(state.hover);
  }

  // ML detection debug overlay (Advanced → Show detection debug)
  if (state.debugDetect) drawDetectDebug();

  ctx.restore();

  // HUD overlays (in screen space)
  if (!state.image && state.walls.length === 0) {
    // hint text only when fully empty
  }
}

// Draw the last ML door/window run's diagnostics on top of the plan: the raw
// model box, plus what placement DID with it (attach to a wall / bridge / drop).
// Lets us watch the lossy placement step on the actual plan instead of reading
// console logs. Runs inside the world transform, so widths divide by zoom.
const DBG = { door: PAL.door, window: PAL.window, attach: '#37d67a', bridge: '#ff9d3b', drop: PAL.warn };
function drawDetectDebug() {
  const dw = detectDebug.dw;
  if (!dw || !dw.records?.length) return;
  const z = state.zoom;
  ctx.save();
  for (const r of dw.records) {
    const boxCol = DBG[r.type] || PAL.door;
    const dropped = r.decision.startsWith('DROP');
    // Raw model box — dashed, faint (solid-ish if it survived placement).
    ctx.setLineDash([5 / z, 4 / z]);
    ctx.lineWidth = 1.5 / z;
    ctx.globalAlpha = dropped ? 0.4 : 0.85;
    ctx.strokeStyle = boxCol;
    ctx.strokeRect(r.bx1, r.by1, r.bx2 - r.bx1, r.by2 - r.by1);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const bcx = (r.bx1 + r.bx2) / 2, bcy = (r.by1 + r.by2) / 2;
    if (r.decision === 'attach') {
      // line from the box to where the opening landed on the wall + a dot there
      ctx.strokeStyle = DBG.attach; ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.moveTo(bcx, bcy); ctx.lineTo(r.placeX, r.placeY); ctx.stroke();
      drawWorldDot(r.placeX, r.placeY, 4 / z, DBG.attach);
    } else if (r.decision === 'bridge' && r.seg) {
      // the floating bridge wall the opening was dropped onto
      ctx.strokeStyle = DBG.bridge; ctx.lineWidth = 4 / z; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r.seg.x1, r.seg.y1); ctx.lineTo(r.seg.x2, r.seg.y2); ctx.stroke();
    } else if (dropped) {
      const s = 6 / z; // red X over dropped detections
      ctx.strokeStyle = DBG.drop; ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.moveTo(bcx - s, bcy - s); ctx.lineTo(bcx + s, bcy + s);
      ctx.moveTo(bcx + s, bcy - s); ctx.lineTo(bcx - s, bcy + s);
      ctx.stroke();
    }
    dbgLabel(r.bx1, r.by1, `${r.type} ${r.conf} ${r.decision}`, boxCol);
  }
  ctx.restore();
}

// Small screen-space label anchored just above a world point (mirrors
// drawLengthLabel's transform reset so text stays crisp at any zoom).
function dbgLabel(wx, wy, text, color) {
  const p = w2s(wx, wy);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '10px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 6;
  ctx.fillStyle = 'rgba(8,9,11,0.78)';
  ctx.fillRect(p.x, p.y - 13, w, 13);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x + 3, p.y - 6);
  ctx.restore();
}

function drawGrid(rect) {
  ctx.fillStyle = PAL.canvasBg;
  ctx.fillRect(0, 0, rect.width, rect.height);
  const step = 40;
  ctx.strokeStyle = PAL.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = (state.pan.x % step); x < rect.width; x += step) {
    ctx.moveTo(x, 0); ctx.lineTo(x, rect.height);
  }
  for (let y = (state.pan.y % step); y < rect.height; y += step) {
    ctx.moveTo(0, y); ctx.lineTo(rect.width, y);
  }
  ctx.stroke();
}

// 1-ft world-space grid (zoom/pan aware), shown only in build-from-scratch mode
// (never when tracing a blueprint — then placement is fluid).
function drawWorldGrid(rect) {
  if (!state.grid || state.image) return;
  const g = pxPerFt(); // one grid cell = 1 ft
  if (!(g > 0)) return;
  const x0 = -state.pan.x / state.zoom, x1 = (rect.width - state.pan.x) / state.zoom;
  const y0 = -state.pan.y / state.zoom, y1 = (rect.height - state.pan.y) / state.zoom;
  ctx.save();
  ctx.strokeStyle = 'rgba(127,183,200,0.18)';
  ctx.lineWidth = 1 / state.zoom;
  ctx.beginPath();
  for (let x = Math.floor(x0 / g) * g; x <= x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = Math.floor(y0 / g) * g; y <= y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();
  ctx.restore();
}

// Snap a world point to the nearest 1-ft grid intersection (scratch mode only —
// never when a blueprint image is loaded, so tracing stays fluid).
function snapToGrid(x, y) {
  if (!state.grid || state.image) return { x, y };
  const g = pxPerFt();
  return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
}

function drawWorldDot(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawLengthLabel(wx, wy, text) {
  const s = w2s(wx, wy);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px system-ui';
  const pad = 4;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15,17,21,0.85)';
  ctx.strokeStyle = PAL.accentStroke;
  ctx.lineWidth = 1;
  const x = s.x + 10, y = s.y - 18;
  ctx.fillRect(x, y, tw + pad * 2, 16);
  ctx.strokeRect(x + 0.5, y + 0.5, tw + pad * 2 - 1, 15);
  ctx.fillStyle = '#e8ecf3';
  ctx.fillText(text, x + pad, y + 11);
  ctx.restore();
}

// Pixels-per-foot used for rendering openings. Falls back to a shared constant
// when the plan hasn't been calibrated, so opening width still maps to pixels
// (and resizing is visible) and matches the 3D view's fraction.
function pxPerFt() { return state.scale ?? PX_PER_FT_FALLBACK; }
function openingWidthPx(o) { return o.width * pxPerFt(); }

function drawOpening(o) {
  const wall = state.walls.find(w => w.id === o.wallId);
  if (!wall) return;
  const isSel = state.selection?.kind === 'opening' && state.selection.id === o.id;
  const widthPx = openingWidthPx(o);
  const wallLen = wallLengthPx(wall);
  const tWidth = widthPx / wallLen;
  const t1 = Math.max(0, o.t - tWidth / 2);
  const t2 = Math.min(1, o.t + tWidth / 2);
  const p1 = pointOnWall(wall, t1);
  const p2 = pointOnWall(wall, t2);
  const ang = wallAngle(wall);
  // perpendicular thickness lines (door = ~6", drawn as a thicker strip)
  const thickness = 6 / state.zoom;
  ctx.save();
  if (o.hidden) ctx.globalAlpha = 0.22; // hidden: faint but still selectable in 2D
  ctx.translate(p1.x, p1.y);
  ctx.rotate(ang);
  const len = dist(p1.x, p1.y, p2.x, p2.y);
  // erase wall behind opening
  ctx.fillStyle = PAL.canvasBg;
  ctx.fillRect(0, -thickness / 2, len, thickness);
  if (o.type === 'door') {
    const col = isSel ? PAL.doorSel : PAL.door;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2 / state.zoom;
    // door jambs
    ctx.beginPath();
    ctx.moveTo(0, -thickness / 2); ctx.lineTo(0, thickness / 2);
    ctx.moveTo(len, -thickness / 2); ctx.lineTo(len, thickness / 2);
    ctx.stroke();
    // arc indicating swing
    ctx.beginPath();
    ctx.arc(0, 0, len, 0, Math.PI / 2);
    ctx.strokeStyle = isSel ? col : 'rgba(168,114,63,0.45)';
    ctx.lineWidth = 1.2 / state.zoom;
    ctx.stroke();
    // door leaf
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2 / state.zoom;
    ctx.stroke();
  } else {
    // window: double parallel lines
    ctx.strokeStyle = isSel ? PAL.windowSel : PAL.window;
    ctx.lineWidth = 1.5 / state.zoom;
    const tt = thickness / 2;
    ctx.beginPath();
    ctx.moveTo(0, -tt); ctx.lineTo(len, -tt);
    ctx.moveTo(0, tt); ctx.lineTo(len, tt);
    ctx.moveTo(0, 0); ctx.lineTo(len, 0);
    // sides
    ctx.moveTo(0, -tt); ctx.lineTo(0, tt);
    ctx.moveTo(len, -tt); ctx.lineTo(len, tt);
    ctx.stroke();
  }
  ctx.restore();

  if (isSel) {
    // Resize grip handles at each edge, oriented perpendicular to the wall.
    drawHandle(p1.x, p1.y, ang);
    drawHandle(p2.x, p2.y, ang);
    // Width readout near the opening center
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    drawWidthLabel(cx, cy, o.width);
  }
}

function drawHandle(wx, wy, wallAng) {
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(wallAng);
  const w = (HANDLE_PX * 0.7) / state.zoom;   // along the wall (slim)
  const h = (HANDLE_PX * 2.2) / state.zoom;   // perpendicular to wall (tall grip)
  ctx.fillStyle = PAL.handle;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2 / state.zoom;
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawWidthLabel(wx, wy, widthFt) {
  const s = w2s(wx, wy);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const text = formatLength(widthFt, state.units);
  ctx.font = '11px system-ui';
  const tw = ctx.measureText(text).width;
  const pad = 5;
  const bx = s.x - (tw + pad * 2) / 2;
  const by = s.y - 28;
  ctx.fillStyle = PAL.accentFill;
  roundRect(ctx, bx, by, tw + pad * 2, 18, 4);
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.fillText(text, bx + pad, by + 13);
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Shared gap-detection tolerances for door/window placement. Spans are in image
// px (ft*scale); the cursor hit radius is in screen px, so divide by zoom.
function gapOpts() {
  return {
    maxGapPx: 10 * pxPerFt(), // doorways/openings are "relatively short"
    minGapPx: 0.5 * pxPerFt(), // ignore endpoints already joined at a corner
    hitPx: 24 / state.zoom,
  };
}

function drawOpeningPreview(hover) {
  let p1, p2;
  if (hover.gap) {
    // Bridging an un-traced gap: span the full distance between the two ends.
    p1 = hover.gap.p1;
    p2 = hover.gap.p2;
  } else {
    const { wall, t } = hover;
    const widthFt = state.tool === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT;
    const widthPx = widthFt * pxPerFt();
    const len = wallLengthPx(wall);
    const tWidth = widthPx / len;
    const t1 = Math.max(0, t - tWidth / 2);
    const t2 = Math.min(1, t + tWidth / 2);
    p1 = pointOnWall(wall, t1);
    p2 = pointOnWall(wall, t2);
  }
  ctx.save();
  ctx.lineWidth = 6 / state.zoom;
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = state.tool === 'door' ? PAL.door : PAL.window;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  // For a gap, dot the two endpoints so it reads as "I'm bridging these ends".
  if (hover.gap) {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = ctx.strokeStyle;
    for (const pt of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5 / state.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Footprint size in pixels for given instance dims (feet).
function footprintPx(w, d) {
  return { wPx: w * pxPerFt(), dPx: d * pxPerFt() };
}

// item: catalog entry; w,d: instance dims in feet.
function drawFurnitureShape(item, x, y, rotDeg, w, d, { fill, stroke, label, lineW, dashed }) {
  const { wPx, dPx } = footprintPx(w, d);
  const count = unitCount(item, w);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotDeg * Math.PI / 180);
  // footprint
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineW / state.zoom;
  if (dashed) ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
  roundRectWorld(-wPx / 2, -dPx / 2, wPx, dPx, Math.min(wPx, dPx) * 0.12);
  ctx.fill();
  ctx.stroke();
  if (dashed) ctx.setLineDash([]);
  // unit subdivisions (basins / cushions / cabinet bays)
  if (item.resize === 'units' && count > 1) {
    ctx.lineWidth = 1 / state.zoom;
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.6;
    for (let i = 1; i < count; i++) {
      const lx = -wPx / 2 + (i * wPx) / count;
      ctx.beginPath();
      ctx.moveTo(lx, -dPx / 2);
      ctx.lineTo(lx, dPx / 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // facing nub (front = +local Y)
  const nub = Math.min(wPx, dPx) * 0.18;
  ctx.beginPath();
  ctx.moveTo(-nub, dPx / 2);
  ctx.lineTo(nub, dPx / 2);
  ctx.lineTo(0, dPx / 2 + nub);
  ctx.closePath();
  ctx.fillStyle = stroke;
  ctx.fill();
  ctx.restore();
  // label (screen-space, upright)
  if (label) {
    const s = w2s(x, y);
    const note = sizeNote(item, w);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '10px system-ui';
    ctx.fillStyle = label;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(note ? `${item.label} ${note}` : item.label, s.x, s.y);
    ctx.textAlign = 'start';
    ctx.restore();
  }
}

// World positions of a furniture item's resize handles (edge midpoints).
function furnHandles(f, item) {
  const w = f.w ?? item.w, d = f.d ?? item.d;
  const { wPx, dPx } = footprintPx(w, d);
  const a = f.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const local = [
    { edge: 'w', lx: wPx / 2, ly: 0, sgn: 1 },
    { edge: 'w', lx: -wPx / 2, ly: 0, sgn: -1 },
    { edge: 'd', lx: 0, ly: dPx / 2, sgn: 1 },
    { edge: 'd', lx: 0, ly: -dPx / 2, sgn: -1 },
  ];
  return local.map(h => ({
    edge: h.edge,
    sgn: h.sgn,
    x: f.x + h.lx * cos - h.ly * sin,
    y: f.y + h.lx * sin + h.ly * cos,
  }));
}

function roundRectWorld(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFurniture(f) {
  const item = getItem(f.type);
  if (!item) return;
  const isSel = state.selection?.kind === 'furniture' && state.selection.id === f.id;
  const clip = !!f._clip;
  const wallMount = item.mount === 'wall';
  ctx.save();
  if (f.hidden) ctx.globalAlpha = 0.22; // hidden: faint but still selectable in 2D
  drawFurnitureShape(item, f.x, f.y, f.rot, f.w ?? item.w, f.d ?? item.d, {
    fill: PAL.furnFill,
    stroke: clip ? PAL.warn : (isSel ? PAL.furnSel : (wallMount ? PAL.wallMountStroke : PAL.furnStroke)),
    label: PAL.furnLabel,
    lineW: (isSel || clip) ? 2.5 : 1.5,
    dashed: clip || wallMount, // dashed outline signals a wall-mounted item
  });
  // resize handles when selected (skip fixed items)
  if (isSel && item.resize !== 'fixed') {
    for (const h of furnHandles(f, item)) drawHandleDot(h.x, h.y);
  }
  if (clip) {
    const s = w2s(f.x, f.y);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '15px system-ui';
    ctx.fillStyle = PAL.warn;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚠', s.x, s.y - 18);
    ctx.textAlign = 'start';
    ctx.restore();
  }
  ctx.restore();
}

function drawHandleDot(wx, wy) {
  const r = (HANDLE_PX * 0.8) / state.zoom;
  ctx.fillStyle = PAL.handle;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5 / state.zoom;
  ctx.beginPath();
  ctx.arc(wx, wy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawFurnitureGhost(typeId, x, y, rotDeg) {
  const item = getItem(typeId);
  if (!item) return;
  let gx = x, gy = y, grot = rotDeg, wallMount = item.mount === 'wall';
  if (wallMount) {
    const pose = wallSnapPose(item, x, y); // ghost rides the nearest wall
    if (pose) { gx = pose.x; gy = pose.y; grot = pose.rot; }
  }
  ctx.save();
  ctx.globalAlpha = 0.7;
  drawFurnitureShape(item, gx, gy, grot, item.w, item.d, {
    fill: PAL.furnGhost,
    stroke: wallMount ? PAL.wallMountStroke : PAL.furnStroke,
    label: null,
    lineW: 1.5,
    dashed: wallMount,
  });
  ctx.restore();
}

// Hit-test furniture: returns the topmost item whose rotated footprint contains
// the world point, or null.
function hitTestFurniture(px, py) {
  for (let i = state.furniture.length - 1; i >= 0; i--) {
    const f = state.furniture[i];
    const item = getItem(f.type);
    if (!item) continue;
    const { wPx, dPx } = footprintPx(f.w ?? item.w, f.d ?? item.d);
    const a = -f.rot * Math.PI / 180;
    const dx = px - f.x, dy = py - f.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= wPx / 2 && Math.abs(ly) <= dPx / 2) return f;
  }
  return null;
}

// If a furniture item is selected, return { edge } of the handle under the
// point, or null.
function hitTestFurnitureHandle(px, py) {
  if (state.selection?.kind !== 'furniture') return null;
  const f = state.furniture.find(x => x.id === state.selection.id);
  if (!f) return null;
  const item = getItem(f.type);
  if (!item || item.resize === 'fixed') return null;
  const r = (HANDLE_PX + HANDLE_HIT_PAD) / state.zoom;
  for (const h of furnHandles(f, item)) {
    if (dist(px, py, h.x, h.y) <= r) return { edge: h.edge, sgn: h.sgn };
  }
  return null;
}

// Anchor the edge OPPOSITE the grabbed handle so resizing moves only the dragged
// side. Returns { edge, sgn, ux, uy, anchor } — anchor is the fixed (opposite)
// edge midpoint in image px; (ux,uy) is the unit vector along the resized axis.
function resizeAnchor(f, item, edge, sgn) {
  const a = f.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const ux = edge === 'w' ? cos : -sin;
  const uy = edge === 'w' ? sin : cos;
  const halfPx = ((edge === 'w' ? (f.w ?? item.w) : (f.d ?? item.d)) * pxPerFt()) / 2;
  return { edge, sgn, ux, uy, anchor: { x: f.x - sgn * halfPx * ux, y: f.y - sgn * halfPx * uy } };
}

// --- Scale calibration snapping ---
const SCALE_SNAP_PX = 11; // screen px radius to snap onto a drawn line

let _outlineCtx = null;
function outlineCtx() {
  if (!state.image?.outline) return null;
  if (!_outlineCtx || _outlineCtx.canvas !== state.image.outline) {
    _outlineCtx = state.image.outline.getContext('2d', { willReadFrequently: true });
  }
  return _outlineCtx;
}

// Snap a world point to the nearest opaque line pixel of the plan outline so a
// calibration click lands on the same drawn feature regardless of exactly where
// the cursor was. Returns {x,y} or null.
function snapToLine(wx, wy, radiusWorld) {
  const octx = outlineCtx();
  if (!octx) return null;
  const W = state.image.w, H = state.image.h;
  const R = Math.max(2, Math.round(radiusWorld));
  const x0 = Math.max(0, Math.round(wx) - R), y0 = Math.max(0, Math.round(wy) - R);
  const x1 = Math.min(W, Math.round(wx) + R), y1 = Math.min(H, Math.round(wy) + R);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw <= 0 || sh <= 0) return null;
  let data;
  try { data = octx.getImageData(x0, y0, sw, sh).data; } catch { return null; }
  let best = null, bestD = Infinity;
  for (let yy = 0; yy < sh; yy++) {
    for (let xx = 0; xx < sw; xx++) {
      if (data[(yy * sw + xx) * 4 + 3] > 40) {
        const gx = x0 + xx, gy = y0 + yy;
        const dd = (gx - wx) ** 2 + (gy - wy) ** 2;
        if (dd < bestD) { bestD = dd; best = { x: gx, y: gy }; }
      }
    }
  }
  return best;
}

// The (snapped) end point of a scale pick: prefer landing on a drawn line,
// otherwise fall back to horizontal/vertical axis snap relative to p1.
function scaleEndPoint(p1, rawX, rawY) {
  const onLine = snapToLine(rawX, rawY, SCALE_SNAP_PX / state.zoom);
  if (onLine) return onLine;
  return snapToAxis(p1.x, p1.y, rawX, rawY);
}

// Compute snapped draft wall end based on current mouse position.
// Straighten to H/V FIRST, then connect to an existing corner only if that corner
// lies on the straightened line — so snapping to a corner never skews the wall
// off-straight (the failure mode when lots of detected walls are around).
function currentDraftWallEnd() {
  if (!state.draftWallStart) return null;
  const m = mouse.world;
  const start = state.draftWallStart;
  const g = snapToGrid(m.x, m.y);                                   // grid (scratch mode only)
  const axis = snapToAxis(start.x, start.y, g.x, g.y, AXIS_SNAP_DEG); // straightened end
  const snap = snapToEndpoint(state.walls, m.x, m.y, SNAP_PX / state.zoom);
  if (snap && dist(snap.x, snap.y, axis.x, axis.y) <= SNAP_PX / state.zoom) {
    return { x: snap.x, y: snap.y };  // corner is on the straight line → connect to it
  }
  return axis;                        // otherwise keep the wall straight
}

// ---------- Interaction ----------

function pointerWorld(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  return { sx, sy, ...s2w(sx, sy) };
}

canvas.addEventListener('mousedown', (e) => {
  const p = pointerWorld(e);
  mouse.down = true;
  mouse.downBtn = e.button;
  mouse.downStart = { sx: p.sx, sy: p.sy, x: p.x, y: p.y, panX: state.pan.x, panY: state.pan.y };
  mouse.world = { x: p.x, y: p.y };
  mouse.x = p.sx; mouse.y = p.sy;

  // Right-click or middle-click = always pan
  if (e.button === 1 || e.button === 2) {
    dragging = { kind: 'pan' };
    return;
  }

  if (state.tool === 'scale') {
    // If you click an existing wall (and aren't mid-measurement), calibrate from
    // that wall's known length instead of drawing a new line.
    if (!state.scalePick) {
      const hitW = hitTestWall(p.x, p.y);
      if (hitW) {
        window.dispatchEvent(new CustomEvent('fpd:wallScale', { detail: { wallId: hitW.id } }));
        return;
      }
    }
    // Two-point scale calibration directly on the plan.
    if (!state.scalePick || state.scalePick.p2) {
      const start = snapToLine(p.x, p.y, SCALE_SNAP_PX / state.zoom) || { x: p.x, y: p.y };
      state.scalePick = { p1: start, p2: null };
    } else {
      const p1 = state.scalePick.p1;
      const end = scaleEndPoint(p1, p.x, p.y);
      state.scalePick.p2 = { x: end.x, y: end.y };
      const d = dist(p1.x, p1.y, end.x, end.y);
      window.dispatchEvent(new CustomEvent('fpd:scalePicked', { detail: { pxDist: d } }));
    }
    emit();
    return;
  }

  if (state.tool === 'furniture') {
    // Drop the armed item, disarm + deselect, and return to Pan so the user
    // can immediately click on the just-placed item to edit it. The palette
    // stays open (state.paletteOpen) — pick another item to arm again.
    if (state.placingFurniture) {
      const f = addFurniture(state.placingFurniture, p.x, p.y, state.placingRot);
      fitBetweenWalls(f);
      state.placingFurniture = null;
      state.selection = null;
      state.tool = 'pan';
      emit();
    }
    return;
  }

  if (state.tool === 'pan' || state.tool === 'select') {
    // 0. Resize handle of the already-selected furniture.
    const fh = hitTestFurnitureHandle(p.x, p.y);
    if (fh) {
      const f = state.furniture.find(x => x.id === state.selection.id);
      const item = f && getItem(f.type);
      dragging = { kind: 'furniture-resize', id: state.selection.id, ...resizeAnchor(f, item, fh.edge, fh.sgn) };
      return;
    }
    // 1. Click on an opening → select; the end-thirds resize, the middle moves.
    const hit = hitTestOpeningWithIntent(p.x, p.y);
    if (hit) {
      state.selection = { kind: 'opening', id: hit.opening.id };
      emit();
      const host0 = state.walls.find(w => w.id === hit.opening.wallId);
      const fromBridgeId = host0 && host0.bridge ? host0.id : null; // carrier for free-float
      const horiz0 = host0 ? Math.abs(host0.x2 - host0.x1) >= Math.abs(host0.y2 - host0.y1) : true;
      dragging = hit.intent === 'move'
        ? { kind: 'opening-move', id: hit.opening.id, fromBridgeId, horiz: horiz0 }
        : { kind: 'opening-resize', id: hit.opening.id, edge: hit.intent };
      return;
    }
    // 1.5 Click on furniture → select & move.
    const hitF = hitTestFurniture(p.x, p.y);
    if (hitF) {
      state.selection = { kind: 'furniture', id: hitF.id };
      emit();
      dragging = { kind: 'furniture-move', id: hitF.id, offx: p.x - hitF.x, offy: p.y - hitF.y };
      return;
    }
    // 2a. Click a wall ENDPOINT → drag JUST that one point (not the whole wall, not the
    // other walls at the corner). Stays axis-locked so the wall never goes diagonal.
    const ep = hitTestWallEndpoint(p.x, p.y);
    if (ep) {
      state.selection = { kind: 'wall', id: ep.w.id };
      emit();
      dragging = { kind: 'wall-endpoint', id: ep.w.id, k: ep.k };
      return;
    }
    // 2b. Click a wall body → select; drag moves it PERPENDICULAR to itself only (walls are
    // never angled), and the perpendicular walls at its ends stretch to follow. That's a
    // room-resize, not a free reposition.
    const hitW = hitTestWall(p.x, p.y);
    if (hitW && !hitW.bridge) {
      state.selection = { kind: 'wall', id: hitW.id };
      emit();
      const horiz = Math.abs(hitW.x2 - hitW.x1) >= Math.abs(hitW.y2 - hitW.y1);
      const conn1 = wallEndpointCluster(hitW.x1, hitW.y1).filter(c => c.w.id !== hitW.id);
      const conn2 = wallEndpointCluster(hitW.x2, hitW.y2).filter(c => c.w.id !== hitW.id);
      dragging = { kind: 'wall-move', id: hitW.id, horiz, sx: p.x, sy: p.y,
                   x1: hitW.x1, y1: hitW.y1, x2: hitW.x2, y2: hitW.y2, conn1, conn2 };
      return;
    }
    if (hitW) { // a bridge (door carrier) — just select, don't wall-edit it
      state.selection = { kind: 'wall', id: hitW.id };
      emit();
      dragging = state.tool === 'pan' ? { kind: 'pan' } : null;
      return;
    }
    // 3. Empty space → deselect; pan tool also starts a pan drag.
    state.selection = null;
    emit();
    dragging = state.tool === 'pan' ? { kind: 'pan' } : null;
  } else if (state.tool === 'wall') {
    const snap = snapToEndpoint(state.walls, p.x, p.y, SNAP_PX / state.zoom);
    const start = snap ? { x: snap.x, y: snap.y } : snapToGrid(p.x, p.y);
    if (!state.draftWallStart) {
      state.draftWallStart = start;
      emit();
    } else {
      // finish wall
      const end = currentDraftWallEnd();
      if (end && dist(state.draftWallStart.x, state.draftWallStart.y, end.x, end.y) > 4 / state.zoom) {
        addWall(state.draftWallStart.x, state.draftWallStart.y, end.x, end.y);
      }
      state.draftWallStart = null;
      emit();
    }
  } else if (state.tool === 'door' || state.tool === 'window') {
    // Prefer filling a gap when the cursor is over one. (Checked BEFORE the wall
    // test: the gap's two bordering wall ends are "near a wall", so a wall-first
    // check would steal every click that lands right on the gap.)
    const gap = findGap(state.walls, p.x, p.y, gapOpts());
    if (gap) {
      const bridge = addWall(gap.p1.x, gap.p1.y, gap.p2.x, gap.p2.y, { bridge: true });
      addOpening(state.tool, bridge.id, 0.5, gap.lenPx / pxPerFt());
    } else {
      const near = nearestWall(state.walls, p.x, p.y, 30 / state.zoom);
      if (near) {
        const widthFt = state.tool === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT;
        addOpening(state.tool, near.wall.id, near.t, widthFt);
      }
    }
  }
});

// Returns { opening, intent } where intent is 'left' | 'right' (resize) or
// 'move' (drag along wall). null if the click missed every opening.
function hitTestOpeningWithIntent(px, py) {
  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const proj = projectPointToSegment(px, py, wall.x1, wall.y1, wall.x2, wall.y2);
    if (proj.dist > WALL_HIT_PX / state.zoom) continue;
    const widthPx = openingWidthPx(o);
    const len = wallLengthPx(wall);
    const halfT = (widthPx / len) / 2;
    // Allow grabbing slightly beyond the opening ends so the visible handle
    // is easy to hit.
    const slackT = (HANDLE_HIT_PAD / state.zoom) / len;
    const t1 = o.t - halfT - slackT;
    const t2 = o.t + halfT + slackT;
    if (proj.t < t1 || proj.t > t2) continue;
    const local = (proj.t - (o.t - halfT)) / (halfT * 2); // 0..1 inside opening
    if (local < EDGE_GRAB_FRAC) return { opening: o, intent: 'left' };
    if (local > 1 - EDGE_GRAB_FRAC) return { opening: o, intent: 'right' };
    return { opening: o, intent: 'move' };
  }
  return null;
}

canvas.addEventListener('mousemove', (e) => {
  const p = pointerWorld(e);
  mouse.world = { x: p.x, y: p.y };
  mouse.x = p.sx; mouse.y = p.sy;

  if (mouse.down && dragging) {
    if (dragging.kind === 'pan') {
      const dx = p.sx - mouse.downStart.sx;
      const dy = p.sy - mouse.downStart.sy;
      state.pan.x = mouse.downStart.panX + dx;
      state.pan.y = mouse.downStart.panY + dy;
      draw();
      return;
    }
    if (dragging.kind === 'wall-endpoint') {
      // Move JUST this one endpoint, locked to keep the wall horizontal or vertical: the
      // moved end stays on whichever axis (from the fixed far end) the cursor is nearer.
      const w = state.walls.find(x => x.id === dragging.id);
      if (w) {
        const k = dragging.k, ok = k === '1' ? '2' : '1';
        const fx = w['x' + ok], fy = w['y' + ok]; // fixed far end
        let tx, ty;
        if (Math.abs(p.x - fx) >= Math.abs(p.y - fy)) { ty = fy; tx = p.x; } // horizontal wall
        else { tx = fx; ty = p.y; }                                          // vertical wall
        if (state.grid) { const g = snapToGrid(tx, ty); tx = g.x; ty = g.y; }
        // Re-join: if the axis-locked end lands on another corner, snap exactly to it.
        const snap = nearestWallEndpoint(tx, ty, new Set([w.id + ':1', w.id + ':2']));
        if (snap) { tx = snap.x; ty = snap.y; }
        w['x' + k] = tx; w['y' + k] = ty;
        emit();
      }
      return;
    }
    if (dragging.kind === 'wall-move') {
      // Move the wall PERPENDICULAR to itself only; the perpendicular walls at its ends
      // stretch to follow (room resize), so nothing bends and corners stay joined.
      const w = state.walls.find(x => x.id === dragging.id);
      if (w) {
        const d = dragging;
        if (d.horiz) {
          let ny = d.y1 + (p.y - d.sy);
          if (state.grid) ny = snapToGrid(0, ny).y;
          w.y1 = ny; w.y2 = ny;
          for (const c of [...d.conn1, ...d.conn2]) c.w['y' + c.k] = ny;
        } else {
          let nx = d.x1 + (p.x - d.sx);
          if (state.grid) nx = snapToGrid(nx, 0).x;
          w.x1 = nx; w.x2 = nx;
          for (const c of [...d.conn1, ...d.conn2]) c.w['x' + c.k] = nx;
        }
        emit();
      }
      return;
    }
    if (dragging.kind === 'furniture-move') {
      const f = state.furniture.find(x => x.id === dragging.id);
      if (f) {
        f.x = p.x - dragging.offx;
        f.y = p.y - dragging.offy;
        resolveAgainstWalls(f); // stop at walls instead of dragging through them
        emit();
      }
      return;
    }
    if (dragging.kind === 'furniture-resize') {
      const f = state.furniture.find(x => x.id === dragging.id);
      if (f) {
        const item = getItem(f.type);
        const { edge, sgn, ux, uy, anchor } = dragging;
        // New extent = distance from the fixed (opposite) edge to the cursor,
        // measured along the resize axis toward the dragged side.
        const extentPx = ((p.x - anchor.x) * ux + (p.y - anchor.y) * uy) * sgn;
        const valueFt = Math.max(0, extentPx) / pxPerFt();
        const next = applyResize(item, edge, valueFt, { w: f.w ?? item.w, d: f.d ?? item.d });
        f.w = next.w; f.d = next.d;
        // Recenter so the anchored edge stays put (only the dragged side moved).
        const halfPx = ((edge === 'w' ? next.w : next.d) * pxPerFt()) / 2;
        f.x = anchor.x + sgn * halfPx * ux;
        f.y = anchor.y + sgn * halfPx * uy;
        resolveAgainstWalls(f); // grow into open space, not through walls
        emit();
      }
      return;
    }
    if (dragging.kind === 'opening-move') {
      const o = state.openings.find(x => x.id === dragging.id);
      if (o) {
        const widthPx = openingWidthPx(o);
        const half = widthPx / 2;
        const R = 14 / state.zoom;                     // magnetic clip radius (screen px)
        // Only snap to real walls long enough to actually hold the door — a short stray
        // wall that juts out shouldn't capture it.
        const realWalls = state.walls.filter(w => !w.bridge && wallLengthPx(w) >= widthPx * 0.6);
        // The door always rides a CARRIER BRIDGE during the drag (smooth + visible); on
        // release the mouseup handler re-attaches it to a real wall if it lies on one.
        // If it grabbed off a real wall, spin up a carrier the first time it moves.
        let host = state.walls.find(w => w.id === o.wallId);
        if (!host || !host.bridge) {
          host = addWall(p.x - half, p.y, p.x + half, p.y, { bridge: true });
          o.wallId = host.id; o.t = 0.5;
        }
        // Magnetically ride the nearest real wall when close, CLAMPED to its span so the
        // door clips at the wall's corners/ends; otherwise float free at the cursor.
        const near = nearestWall(realWalls, p.x, p.y, R);
        let cx, cy, ux, uy;
        if (near) {
          const w = near.wall, len = wallLengthPx(w) || 1;
          const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
          ux = dx / len; uy = dy / len;
          const ht = Math.min(0.49, half / len);
          const t = Math.max(ht, Math.min(1 - ht, near.t));
          cx = w.x1 + t * dx; cy = w.y1 + t * dy;
        } else {
          cx = p.x; cy = p.y;
          ux = dragging.horiz ? 1 : 0; uy = dragging.horiz ? 0 : 1;
        }
        host.x1 = cx - half * ux; host.y1 = cy - half * uy;
        host.x2 = cx + half * ux; host.y2 = cy + half * uy;
        o.t = 0.5;
        emit();
      }
      return;
    }
    if (dragging.kind === 'opening-resize') {
      const o = state.openings.find(x => x.id === dragging.id);
      if (o) {
        const wall = state.walls.find(w => w.id === o.wallId);
        // Floating (bridge) opening: drag THIS end freely and snap it to the
        // nearest wall ending (corner) or wall line, reshaping the door to fit.
        if (wall && wall.bridge) {
          const realWalls = state.walls.filter(w => !w.bridge);
          let tx = p.x, ty = p.y;
          const end = snapToEndpoint(realWalls, p.x, p.y, 14 / state.zoom);
          if (end) { tx = end.x; ty = end.y; }
          else {
            const near = nearestWall(realWalls, p.x, p.y, 12 / state.zoom);
            if (near) { tx = near.x; ty = near.y; }
          }
          if (dragging.edge === 'left') { wall.x1 = tx; wall.y1 = ty; } // t≈0 end
          else { wall.x2 = tx; wall.y2 = ty; }                          // t≈1 end
          const lenPx = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
          o.width = Math.max(0.5, lenPx / pxPerFt()); // door fills the bridge
          o.t = 0.5;
          emit();
          return;
        }
        const proj = projectPointToSegment(p.x, p.y, wall.x1, wall.y1, wall.x2, wall.y2);
        const len = wallLengthPx(wall);
        const oldHalfT = (openingWidthPx(o) / len) / 2;
        const fixedT = dragging.edge === 'left' ? (o.t + oldHalfT) : (o.t - oldHalfT);
        const movedT = Math.max(0, Math.min(1, proj.t));
        const newT1 = Math.min(fixedT, movedT);
        const newT2 = Math.max(fixedT, movedT);
        const newWidthPx = (newT2 - newT1) * len;
        const minFt = 1, maxFt = 12;
        let newFt = Math.max(minFt, Math.min(maxFt, newWidthPx / pxPerFt()));
        // Update width and recenter so the opposite edge stays put.
        const newHalfT = ((newFt * pxPerFt()) / len) / 2;
        o.width = newFt;
        o.t = dragging.edge === 'left' ? fixedT - newHalfT : fixedT + newHalfT;
        o.t = Math.max(newHalfT, Math.min(1 - newHalfT, o.t));
        emit();
      }
      return;
    }
  }

  // Scale-pick: live rubber-band line to cursor
  if (state.tool === 'scale') {
    canvas.style.cursor = 'crosshair';
    if (state.scalePick && !state.scalePick.p2) draw();
    return;
  }

  // Furniture placement: ghost follows cursor
  if (state.tool === 'furniture') {
    canvas.style.cursor = state.placingFurniture ? 'copy' : 'default';
    if (state.placingFurniture) draw();
    return;
  }

  // Cursor feedback for pan/select tools
  if (state.tool === 'pan' || state.tool === 'select') {
    const fh = hitTestFurnitureHandle(p.x, p.y);
    const hit = hitTestOpeningWithIntent(p.x, p.y);
    if (fh) {
      canvas.style.cursor = 'nwse-resize';
    } else if (hit) {
      canvas.style.cursor = hit.intent === 'move' ? 'move' : 'ew-resize';
    } else if (hitTestFurniture(p.x, p.y)) {
      canvas.style.cursor = 'move';
    } else if (hitTestWall(p.x, p.y)) {
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = state.tool === 'pan' ? 'grab' : 'default';
    }
  } else if (state.tool === 'wall') {
    canvas.style.cursor = 'crosshair';
  } else if (state.tool === 'door' || state.tool === 'window') {
    canvas.style.cursor = 'crosshair';
  }

  // hover preview for door/window — gap first (see placement note above), so the
  // preview appears when the cursor is right on a gap, not only in its middle.
  if (state.tool === 'door' || state.tool === 'window') {
    const gap = findGap(state.walls, p.x, p.y, gapOpts());
    if (gap) {
      state.hover = { gap };
    } else {
      const near = nearestWall(state.walls, p.x, p.y, 30 / state.zoom);
      state.hover = near || null;
    }
    draw();
    return;
  }

  // redraw if drawing wall (to update preview)
  if (state.tool === 'wall' && state.draftWallStart) {
    draw();
    return;
  }
});

canvas.addEventListener('mouseup', () => {
  // On releasing a furniture move/resize, slide it out of any wall it overlaps.
  if (dragging && (dragging.kind === 'furniture-move' || dragging.kind === 'furniture-resize')) {
    const f = state.furniture.find(x => x.id === dragging.id);
    if (f) { resolveAgainstWalls(f); emit(); }
  }
  // After dragging an opening: if a floating opening now lies ALONG a real wall
  // (both ends on its line), attach it to that wall so the wall segments around it
  // — otherwise the wall covers the window in 3D and it "won't pop up". Only fires
  // when it's genuinely on the wall, never a snap-to-nearest from afar. Then drop
  // any carrier bridge no opening uses anymore.
  if (dragging && (dragging.kind === 'opening-move' || dragging.kind === 'opening-resize')) {
    const o = state.openings.find(x => x.id === dragging.id);
    const host = o && state.walls.find(w => w.id === o.wallId);
    if (o && host && host.bridge) {
      const TOL = 14 / state.zoom;
      const widthPx = openingWidthPx(o);  // KEEP the door's own size — don't resize it to the wall
      for (const w of state.walls) {
        if (w.bridge) continue;
        const p1 = projectPointToSegment(host.x1, host.y1, w.x1, w.y1, w.x2, w.y2);
        const p2 = projectPointToSegment(host.x2, host.y2, w.x1, w.y1, w.x2, w.y2);
        if (p1.dist <= TOL && p2.dist <= TOL) {
          const len = wallLengthPx(w);
          o.wallId = w.id;
          // Preserve width; just place the door's CENTER on the wall, clamped within its
          // span so it clips at the corner (instead of stretching to fill the wall).
          const half = Math.min(0.49, (widthPx / len) / 2);
          o.t = Math.max(half, Math.min(1 - half, (p1.t + p2.t) / 2));
          break;
        }
      }
    }
    // Drop any carrier bridge no opening uses anymore (incl. ones spun up mid-drag).
    state.walls = state.walls.filter(w => !w.bridge || state.openings.some(op => op.wallId === w.id));
    emit();
  }
  mouse.down = false;
  dragging = null;
});

canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const worldBefore = s2w(sx, sy);
  const factor = Math.exp(-e.deltaY * 0.0015);
  state.zoom = Math.max(0.05, Math.min(40, state.zoom * factor));
  const worldAfter = s2w(sx, sy);
  state.pan.x += (worldAfter.x - worldBefore.x) * state.zoom;
  state.pan.y += (worldAfter.y - worldBefore.y) * state.zoom;
  draw();
}, { passive: false });

// ---------- Touch support (tablet) ----------
// Non-invasive shim so the 2D editor works on touch without forking any of the
// drawing / selection / drag logic: ONE finger is translated into the existing
// mouse handlers (mousedown/move/up), and TWO fingers pinch-to-zoom + pan the
// canvas (replacing the wheel + drag-pan). `touch-action: none` on the canvas
// stops the browser from scrolling/zooming the page instead.
let touchMode = null; // null | 'single' | 'pinch' | 'rest' (fingers down but ignored)
let pinch = null;     // { dist, mx, my } in client px

function dispatchMouse(type, t, button = 0) {
  canvas.dispatchEvent(new MouseEvent(type, {
    clientX: t.clientX, clientY: t.clientY, button, bubbles: true, cancelable: true,
  }));
}

function pinchState(touches) {
  const a = touches[0], b = touches[1];
  return {
    dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
    mx: (a.clientX + b.clientX) / 2,
    my: (a.clientY + b.clientY) / 2,
  };
}

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    touchMode = 'single';
    dispatchMouse('mousedown', e.touches[0]);
  } else if (e.touches.length >= 2) {
    // A second finger arrived: end any single-finger drag cleanly, then pinch.
    if (touchMode === 'single') dispatchMouse('mouseup', e.touches[0]);
    touchMode = 'pinch';
    pinch = pinchState(e.touches);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (touchMode === 'single' && e.touches.length === 1) {
    dispatchMouse('mousemove', e.touches[0]);
  } else if (touchMode === 'pinch' && e.touches.length >= 2) {
    const cur = pinchState(e.touches);
    const rect = canvas.getBoundingClientRect();
    const sx = cur.mx - rect.left, sy = cur.my - rect.top;
    // Zoom around the pinch midpoint (same math as the wheel handler)...
    const worldBefore = s2w(sx, sy);
    const factor = pinch.dist > 0 ? cur.dist / pinch.dist : 1;
    state.zoom = Math.max(0.05, Math.min(40, state.zoom * factor));
    const worldAfter = s2w(sx, sy);
    state.pan.x += (worldAfter.x - worldBefore.x) * state.zoom;
    state.pan.y += (worldAfter.y - worldBefore.y) * state.zoom;
    // ...and pan by however far the two fingers' midpoint travelled.
    state.pan.x += cur.mx - pinch.mx;
    state.pan.y += cur.my - pinch.my;
    pinch = cur;
    draw();
  }
}, { passive: false });

function endTouch(e) {
  e.preventDefault();
  if (touchMode === 'single' && e.changedTouches.length) {
    dispatchMouse('mouseup', e.changedTouches[0]);
  }
  if (e.touches.length === 0) { touchMode = null; pinch = null; }
  else if (e.touches.length === 1) { touchMode = 'rest'; pinch = null; } // wait for full release
  else { touchMode = 'pinch'; pinch = pinchState(e.touches); }
}
canvas.addEventListener('touchend', endTouch, { passive: false });
canvas.addEventListener('touchcancel', endTouch, { passive: false });

window.addEventListener('keydown', (e) => {
  if (state.view !== '2d') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection) {
      e.preventDefault();
      deleteSelection();
    }
  }
  if (e.key === 'Escape') {
    state.draftWallStart = null;
    state.selection = null;
    state.scalePick = null;
    state.placingFurniture = null;
    emit();
  }
});

// Hit tests in world space.
function hitTestWall(px, py) {
  const near = nearestWall(state.walls, px, py, WALL_HIT_PX / state.zoom);
  return near?.wall ?? null;
}

// Nearest REAL-wall endpoint (corner) under the cursor, or null. Bridges (door carriers)
// are edited via the door tools, so they're excluded from wall editing.
function hitTestWallEndpoint(px, py) {
  const r = (HANDLE_PX + HANDLE_HIT_PAD) / state.zoom;
  let best = null, bestD = r;
  for (const w of state.walls) {
    if (w.bridge) continue;
    for (const k of ['1', '2']) {
      const d = dist(px, py, w['x' + k], w['y' + k]);
      if (d <= bestD) { bestD = d; best = { w, k, x: w['x' + k], y: w['y' + k] }; }
    }
  }
  return best;
}

// Every real-wall endpoint coincident with (gx,gy) — a shared CORNER. Dragging one
// moves them all so joined walls stay connected.
function wallEndpointCluster(gx, gy) {
  const tol = 3; // px — endpoints this close are the same corner
  const cl = [];
  for (const w of state.walls) {
    if (w.bridge) continue;
    for (const k of ['1', '2']) {
      if (dist(gx, gy, w['x' + k], w['y' + k]) <= tol) cl.push({ w, k });
    }
  }
  return cl;
}

// Nearest real-wall endpoint to snap a moved point to (corner-join), or null. `exclude`
// is a Set of "wallId:end" keys to ignore (the piece being dragged).
function nearestWallEndpoint(px, py, exclude) {
  const r = SNAP_PX / state.zoom;
  let best = null, bestD = r;
  for (const w of state.walls) {
    if (w.bridge) continue;
    for (const k of ['1', '2']) {
      if (exclude && exclude.has(w.id + ':' + k)) continue;
      const d = dist(px, py, w['x' + k], w['y' + k]);
      if (d <= bestD) { bestD = d; best = { x: w['x' + k], y: w['y' + k] }; }
    }
  }
  return best;
}

function hitTestOpening(px, py) {
  // pick openings that have point within their span and close to wall line
  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const proj = projectPointToSegment(px, py, wall.x1, wall.y1, wall.x2, wall.y2);
    if (proj.dist > WALL_HIT_PX / state.zoom) continue;
    const widthPx = openingWidthPx(o);
    const len = wallLengthPx(wall);
    const halfT = (widthPx / len) / 2;
    if (proj.t >= o.t - halfT && proj.t <= o.t + halfT) {
      return o;
    }
  }
  return null;
}

export function init() {
  resize();
}

// Re-render on any state change.
subscribe(draw);
