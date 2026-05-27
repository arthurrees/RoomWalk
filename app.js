// Main entry: wires DOM UI to state and the 2D/3D views.
import {
  state, subscribe, emit, setTool, setView, setScale, resetAll, reseedIds,
  clearWalls, clearOpenings, clearFurniture, deleteSelection, armFurniture,
} from './state.js';
import { wallLengthPx, parseLength, formatLength, formatArea, FT_PER_M } from './geom.js';
import { CATALOG, CATEGORIES, getItem, applyResize, sizeNote, bedSizeName } from './furniture.js';
import { resolveAgainstWalls } from './collision.js';
import * as view2d from './view2d.js';
import * as view3d from './view3d.js';

// --- View switching ---
const viewBtns = document.querySelectorAll('.view-toggle button');
viewBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    switchView(v);
  });
});

function switchView(v) {
  if (state.view === v) return;
  // Leaving walk?
  if (state.view === 'walk') view3d.exitWalk();
  setView(v);
  viewBtns.forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.getElementById('view-2d').classList.toggle('active', v === '2d');
  document.getElementById('view-3d').classList.toggle('active', v !== '2d');
  if (v === '2d') {
    view2d.init();
    view2d.draw();
  } else if (v === '3d') {
    view3d.resize();
    view3d.rebuild();
    view3d.frameOrbit();
  } else if (v === 'walk') {
    view3d.resize();
    view3d.rebuild();
    view3d.enterWalk();
  }
}

// --- Tool buttons ---
const toolBtns = document.querySelectorAll('.tool');
toolBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setTool(btn.dataset.tool);
  });
});

// --- Furniture palette ---
const paletteBody = document.getElementById('palette-body');
function buildPalette() {
  paletteBody.innerHTML = '';
  for (const cat of CATEGORIES) {
    const head = document.createElement('div');
    head.className = 'palette-cat';
    head.textContent = cat;
    paletteBody.appendChild(head);
    for (const item of CATALOG.filter(i => i.cat === cat)) {
      const b = document.createElement('button');
      b.className = 'palette-item';
      b.dataset.id = item.id;
      let dim;
      if (state.units === 'metric') {
        dim = `${Math.round(item.w / FT_PER_M * 100)}×${Math.round(item.d / FT_PER_M * 100)} cm`;
      } else {
        dim = `${Math.round(item.w * 12)}×${Math.round(item.d * 12)}"`;
      }
      b.innerHTML = `<span>${item.label}</span><span class="dim">${dim}</span>`;
      b.addEventListener('click', () => armFurniture(item.id));
      paletteBody.appendChild(b);
    }
  }
}
buildPalette();

subscribe(() => {
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === state.tool));
  updateScaleInfo();
  updateItemPanel();
  // palette visibility + armed highlight
  document.getElementById('palette').hidden = state.tool !== 'furniture';
  paletteBody.querySelectorAll('.palette-item').forEach(b =>
    b.classList.toggle('armed', b.dataset.id === state.placingFurniture));
  // Declutter the bottom center: hide the hint pills (and walk instructions)
  // whenever an item is selected so only the editing panel shows there.
  const editing = !!state.selection;
  const hint2 = document.getElementById('hint-2d');
  if (hint2) hint2.style.display = (editing || state.image || state.walls.length) ? 'none' : '';
  const hint3 = document.getElementById('hint-3d');
  if (hint3) hint3.style.display = editing ? 'none' : '';
  const walkInstr = document.querySelector('.walk-instructions');
  if (walkInstr) walkInstr.style.display = editing ? 'none' : '';
});

// --- File upload (image) ---
const fileInput = document.getElementById('file-input');
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Read as a data URL so the image can be embedded when saving the project.
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const outline = view2d.buildOutline(img, state.outlineThreshold);
      state.image = { el: img, w: img.naturalWidth, h: img.naturalHeight, outline, dataUrl: reader.result };
      view2d.fitImage();
      emit();
      toast('Floor plan loaded. Trace the walls with the Wall tool.');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

// --- Help / how-to dropdown ---
const helpBtn = document.getElementById('help-btn');
const helpMenu = document.getElementById('help-menu');
helpBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  helpMenu.hidden = !helpMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!helpMenu.contains(e.target) && e.target !== helpBtn) helpMenu.hidden = true;
});

// --- Save / Open project ---
const saveBtn = document.getElementById('save-btn');
const openBtn = document.getElementById('open-btn');
const openInput = document.getElementById('open-input');

saveBtn.addEventListener('click', saveProject);
openBtn.addEventListener('click', () => openInput.click());
openInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) openProject(file);
  openInput.value = '';
});

function saveProject() {
  const data = {
    app: 'floor-plan-designer',
    version: 1,
    savedAt: new Date().toISOString(),
    units: state.units,
    scale: state.scale,
    wallHeightFt: state.wallHeightFt,
    imageOpacity: state.imageOpacity,
    outlineMode: state.outlineMode,
    outlineThreshold: state.outlineThreshold,
    walls: state.walls,
    openings: state.openings,
    furniture: state.furniture.map(({ id, type, x, y, rot, w, d }) => ({ id, type, x, y, rot, w, d })),
    image: state.image ? { dataUrl: state.image.dataUrl || null, w: state.image.w, h: state.image.h } : null,
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `floorplan-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Project saved to your downloads.');
}

function openProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast('Could not read that file.'); return; }
    if (!data || !Array.isArray(data.walls)) { toast('That doesn’t look like a project file.'); return; }
    applyProject(data);
  };
  reader.readAsText(file);
}

function applyProject(data) {
  state.units = data.units || 'imperial';
  state.scale = data.scale ?? null;
  state.wallHeightFt = data.wallHeightFt ?? 9;
  state.imageOpacity = data.imageOpacity ?? 0.85;
  state.outlineMode = data.outlineMode ?? true;
  state.outlineThreshold = data.outlineThreshold ?? 120;
  state.walls = data.walls || [];
  state.openings = data.openings || [];
  state.furniture = (data.furniture || []).map(f => {
    const item = getItem(f.type);
    return { ...f, w: f.w ?? (item ? item.w : 2), d: f.d ?? (item ? item.d : 2), rot: f.rot || 0 };
  });
  state.selection = null;
  state.placingFurniture = null;
  reseedIds();

  // sync UI controls to the loaded state
  unitsSelect.value = state.units; syncUnitsUI(); buildPalette();
  opacitySlider.value = Math.round(state.imageOpacity * 100);
  outlineToggle.checked = state.outlineMode;
  outlineThreshold.value = state.outlineThreshold;

  const finish = () => {
    if (state.view !== '2d') switchView('2d');
    view2d.init();      // ensure the 2D canvas is sized before fitting
    view2d.fitImage();
    emit();
    toast('Project loaded.');
  };
  if (data.image && data.image.dataUrl) {
    const img = new Image();
    img.onload = () => {
      state.image = {
        el: img, w: img.naturalWidth, h: img.naturalHeight,
        dataUrl: data.image.dataUrl, outline: view2d.buildOutline(img, state.outlineThreshold),
      };
      finish();
    };
    img.src = data.image.dataUrl;
  } else {
    state.image = null;
    finish();
  }
}

// --- Advanced dropdown ---
const advBtn = document.getElementById('advanced-btn');
const advMenu = document.getElementById('advanced-menu');
advBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  advMenu.hidden = !advMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!advMenu.contains(e.target) && e.target !== advBtn) advMenu.hidden = true;
});
advMenu.querySelectorAll('button[data-action]').forEach(b => {
  b.addEventListener('click', () => {
    const a = b.dataset.action;
    advMenu.hidden = true;
    if (a === 'set-scale') startSetScale();
    else if (a === 'calibrate-sqft') openCalibrateSqft();
    else if (a === 'calibrate-distance') openCalibrateDistance();
    else if (a === 'clear-walls') { clearWalls(); toast('Walls cleared'); }
    else if (a === 'clear-openings') { clearOpenings(); toast('Doors/windows cleared'); }
    else if (a === 'clear-furniture') { clearFurniture(); toast('Furniture cleared'); }
    else if (a === 'reset-all') { if (confirm('Reset everything?')) { resetAll(); toast('Reset.'); } }
  });
});

// Opacity slider
const opacitySlider = document.getElementById('opacity');
opacitySlider.addEventListener('input', () => {
  state.imageOpacity = parseInt(opacitySlider.value, 10) / 100;
  emit();
});

// Blueprint outline toggle
const outlineToggle = document.getElementById('outline-mode');
outlineToggle.addEventListener('change', () => {
  state.outlineMode = outlineToggle.checked;
  emit();
});

// Outline detail (luminance threshold) — reprocess current image.
const outlineThreshold = document.getElementById('outline-threshold');
outlineThreshold.addEventListener('input', () => {
  state.outlineThreshold = parseInt(outlineThreshold.value, 10);
  if (state.image?.el) {
    state.image.outline = view2d.buildOutline(state.image.el, state.outlineThreshold);
  }
  emit();
});

// Wall height (input shown in the current unit; stored in feet)
const heightInput = document.getElementById('wall-height');
const heightLabel = document.getElementById('wall-height-label');
heightInput.addEventListener('input', () => {
  const v = parseFloat(heightInput.value);
  if (!Number.isNaN(v) && v > 0) {
    state.wallHeightFt = state.units === 'metric' ? v * FT_PER_M : v;
    emit();
  }
});

// Units dropdown
const unitsSelect = document.getElementById('units-select');
unitsSelect.addEventListener('change', () => {
  state.units = unitsSelect.value;
  syncUnitsUI();
  buildPalette();
  emit();
});

// Update unit-dependent controls (wall-height input bounds/label, palette dims).
function syncUnitsUI() {
  if (state.units === 'metric') {
    heightLabel.textContent = 'Wall height (m)';
    heightInput.min = '1.8'; heightInput.max = '4.3'; heightInput.step = '0.1';
    heightInput.value = (state.wallHeightFt / FT_PER_M).toFixed(1);
  } else {
    heightLabel.textContent = 'Wall height (ft)';
    heightInput.min = '6'; heightInput.max = '14'; heightInput.step = '0.5';
    heightInput.value = state.wallHeightFt.toFixed(1).replace(/\.0$/, '');
  }
}

// --- Modal helpers ---
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalOk = document.getElementById('modal-ok');
const modalCancel = document.getElementById('modal-cancel');

function openModal({ title, body, onOk }) {
  modalTitle.textContent = title;
  modalBody.innerHTML = '';
  if (typeof body === 'string') modalBody.textContent = body;
  else modalBody.appendChild(body);
  modal.hidden = false;
  const ok = () => { if (onOk?.() !== false) closeModal(); };
  modalOk.onclick = ok;
  modalCancel.onclick = closeModal;
}
function closeModal() { modal.hidden = true; }

// Parse a length string into feet. Accepts: 12, 12.5, 24'-6", 24' 6", 12'6,
// Parse a length in the current unit system → feet.
function parseLengthToFeet(raw) {
  return parseLength(raw, state.units);
}

let pendingScalePxDist = null;

function startSetScale() {
  if (!state.image && state.walls.length === 0) {
    toast('Upload a floor plan first, then point at a printed dimension.');
    return;
  }
  state.scalePick = null;
  setTool('scale');
  toast('Click a drawn wall to enter its length, or click the two ends of a known dimension.', 4500);
}

// Clicking a wall while the Scale tool is active calibrates from that wall.
window.addEventListener('fpd:wallScale', (e) => {
  state.selection = { kind: 'wall', id: e.detail.wallId };
  emit();
  openCalibrateDistance();
});

// view2d dispatches this once the user has clicked both endpoints.
window.addEventListener('fpd:scalePicked', (e) => {
  pendingScalePxDist = e.detail.pxDist;
  if (!pendingScalePxDist || pendingScalePxDist < 2) {
    toast('Those points are too close together — try again.');
    state.scalePick = null;
    emit();
    return;
  }
  openScaleValueModal();
});

function openScaleValueModal() {
  const metric = state.units === 'metric';
  const ph = metric ? 'e.g. 7.5 m, 350 cm' : 'e.g. 24\'-6", 12\'6, 36", or 15.5';
  const presets = metric
    ? [['0.9', 'Standard door 0.9 m']]
    : [['3', 'Standard door 3\'-0"'], ['2.667', 'Door 2\'-8"']];
  const body = document.createElement('div');
  body.innerHTML = `
    <div>What is the real-world length between those two points?</div>
    <input id="scale-len-input" type="text" placeholder="${ph}" autocomplete="off" />
    <div class="preset-row" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
      ${presets.map(([v, l]) => `<button type="button" class="preset" data-len="${v}">${l}</button>`).join('')}
    </div>
  `;
  openModal({
    title: 'Set scale from a dimension',
    body,
    onOk: () => {
      const feet = parseLengthToFeet(document.getElementById('scale-len-input').value);
      if (!feet) { toast("Couldn't read that length."); return false; }
      setScale(pendingScalePxDist / feet);
      state.scalePick = null;
      setTool('pan');
      toast('Scale set.');
      reportAreaIfPossible();
    },
  });
  const input = document.getElementById('scale-len-input');
  setTimeout(() => input?.focus(), 50);
  body.querySelectorAll('.preset').forEach(p => {
    // preset value is already in current-unit terms (m for metric, ft for imperial)
    p.addEventListener('click', () => { input.value = metric ? p.dataset.len + ' m' : p.dataset.len; input.focus(); });
  });
}

function openCalibrateSqft() {
  if (state.walls.length < 3) {
    toast('Draw the room walls first, then calibrate by sqft.');
    return;
  }
  const metric = state.units === 'metric';
  const unitLabel = metric ? 'square meters (m²)' : 'square footage (sq ft)';
  const body = document.createElement('div');
  body.innerHTML = `
    <div>Enter the floor plan's total ${unitLabel}. The app will auto-scale your traced walls to match.</div>
    <input id="sqft-input" type="number" placeholder="${metric ? 'e.g. 79' : 'e.g. 850'}" min="1" />
  `;
  openModal({
    title: 'Calibrate by area',
    body,
    onOk: () => {
      let val = parseFloat(document.getElementById('sqft-input').value);
      if (!val || val <= 0) { toast('Enter a positive number.'); return false; }
      if (metric) val = val * FT_PER_M * FT_PER_M; // m² → ft²
      const areaPx = polygonAreaFromWalls(state.walls);
      if (!areaPx || areaPx <= 0) {
        toast('Could not compute area from walls. Use a closed shape, or calibrate by a wall.');
        return false;
      }
      // areaPx (in px²) corresponds to val ft². 1 ft = sqrt(areaPx/val) px.
      setScale(Math.sqrt(areaPx / val));
      toast('Calibrated from area.');
    },
  });
  setTimeout(() => document.getElementById('sqft-input')?.focus(), 50);
}

function openCalibrateDistance() {
  if (!state.selection || state.selection.kind !== 'wall') {
    toast('Select a wall (with the Pan or Select tool) whose real-world length you know.');
    return;
  }
  const wall = state.walls.find(w => w.id === state.selection.id);
  const lenPx = wallLengthPx(wall);
  const ph = state.units === 'metric' ? 'e.g. 3.8 m, 380 cm' : 'e.g. 12\'-6", 12\'6, or 12.5';
  const body = document.createElement('div');
  body.innerHTML = `
    <div>How long is the selected wall in real life?</div>
    <input id="dist-input" type="text" placeholder="${ph}" autocomplete="off" />
  `;
  openModal({
    title: 'Calibrate by selected wall',
    body,
    onOk: () => {
      const v = parseLengthToFeet(document.getElementById('dist-input').value);
      if (!v || v <= 0) { toast("Couldn't read that length."); return false; }
      setScale(lenPx / v);
      if (state.tool === 'scale') setTool('pan');
      toast('Calibrated from wall.');
      reportAreaIfPossible();
    },
  });
  setTimeout(() => document.getElementById('dist-input')?.focus(), 50);
}

// Polygon area from walls treated as a closed loop via wall endpoints in
// order. Only meaningful if walls form a simple polygon, but for typical
// traced rooms this works well enough as a calibration heuristic.
function polygonAreaFromWalls(walls) {
  if (walls.length < 3) return 0;
  // Try to chain walls into a polygon by matching shared endpoints.
  const TOL = 4;
  const used = new Array(walls.length).fill(false);
  const path = [];
  // Start from first wall
  path.push({ x: walls[0].x1, y: walls[0].y1 });
  path.push({ x: walls[0].x2, y: walls[0].y2 });
  used[0] = true;
  let safety = walls.length * 2;
  while (safety-- > 0) {
    const tail = path[path.length - 1];
    let foundIdx = -1, foundEndpoint = null;
    for (let i = 0; i < walls.length; i++) {
      if (used[i]) continue;
      const w = walls[i];
      if (Math.hypot(w.x1 - tail.x, w.y1 - tail.y) <= TOL) { foundIdx = i; foundEndpoint = { x: w.x2, y: w.y2 }; break; }
      if (Math.hypot(w.x2 - tail.x, w.y2 - tail.y) <= TOL) { foundIdx = i; foundEndpoint = { x: w.x1, y: w.y1 }; break; }
    }
    if (foundIdx < 0) break;
    used[foundIdx] = true;
    path.push(foundEndpoint);
  }
  // Shoelace
  let a = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i], q = path[(i + 1) % path.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// --- Scale readout & verification ---

// Floor area in sq ft from traced walls, or null if not computable.
function computeFloorAreaSqft() {
  if (!state.scale || state.walls.length < 3) return null;
  const areaPx = polygonAreaFromWalls(state.walls);
  if (!areaPx) return null;
  return areaPx / (state.scale * state.scale);
}

// Overall footprint W×H in feet, or null.
function computeFootprintFt() {
  if (!state.scale || state.walls.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of state.walls) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  }
  return { w: (maxX - minX) / state.scale, h: (maxY - minY) / state.scale };
}

function updateScaleInfo() {
  const u = state.units;
  const perUnit = u === 'metric' ? 'px/m' : 'px/ft';
  const scalePer = state.scale ? (u === 'metric' ? state.scale * FT_PER_M : state.scale) : 0;

  // Compact sidebar label
  const el = document.getElementById('scale-info');
  if (el) el.textContent = state.scale ? `${scalePer.toFixed(1)}\n${perUnit}` : 'No scale set';

  // Prominent on-canvas panel
  const panel = document.getElementById('readout');
  if (!panel) return;
  const show = (state.scale || state.walls.length > 0) && state.view !== 'walk';
  panel.hidden = !show;
  if (!show) return;

  document.getElementById('ro-scale').textContent =
    state.scale ? `${scalePer.toFixed(1)} ${perUnit}` : 'not set';
  const fp = computeFootprintFt();
  document.getElementById('ro-foot').textContent =
    fp ? `${formatLength(fp.w, u)} × ${formatLength(fp.h, u)}` : '—';

  const roArea = document.getElementById('ro-area');
  const poly = computeFloorAreaSqft();
  if (poly) {
    roArea.textContent = formatArea(poly, u);
  } else if (fp && state.walls.length >= 3) {
    roArea.textContent = `~${formatArea(fp.w * fp.h, u)}`;
  } else {
    roArea.textContent = state.scale ? 'trace a closed room' : '—';
  }
}

// After calibrating, surface the computed area so the user can cross-check it
// against the listing's stated square footage.
function reportAreaIfPossible() {
  const area = computeFloorAreaSqft();
  if (area) {
    toast(`Floor area ≈ ${formatArea(area, state.units)} — compare to the listing to verify.`, 4000);
  }
}

// --- Toasts ---
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// --- Keyboard shortcuts ---
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!modal.hidden) return;
  const k = e.key.toLowerCase();
  // 'r' rotates furniture (when placing or a furniture item is selected) in any
  // view; otherwise it's the window-tool shortcut.
  const rIsRotate = state.tool === 'furniture' || state.selection?.kind === 'furniture';
  if (k === 'r' && rIsRotate) {
    rotateFurniture90();
    return;
  }
  // While walking, WASD belongs to the player — don't trigger tool shortcuts.
  if (state.view !== 'walk') {
    if (k === 'v') setTool('pan');
    else if (k === 'w') setTool('wall');
    else if (k === 'd') setTool('door');
    else if (k === 'r') setTool('window');
    else if (k === 'i') setTool('furniture');
  }
  if (k === 'delete' || k === 'backspace') {
    if (state.selection) { e.preventDefault(); deleteSelection(); }
  } else if (k === 'escape') {
    if (state.placingFurniture) { state.placingFurniture = null; emit(); }
  } else if (k === '1') switchView('2d');
  else if (k === '2') switchView('3d');
  else if (k === '3') switchView('walk');
});

// --- Selection panel (resize / rotate / delete in any view) ---
const itemPanel = document.getElementById('item-panel');
itemPanel.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  if (act === 'delete') deleteSelection();
  else if (act === 'rotate') rotateFurniture90();
  else if (act === 'w-') nudgeFurniture('w', -1);
  else if (act === 'w+') nudgeFurniture('w', 1);
  else if (act === 'd-') nudgeFurniture('d', -1);
  else if (act === 'd+') nudgeFurniture('d', 1);
});

function selectedFurniture() {
  if (state.selection?.kind !== 'furniture') return null;
  return state.furniture.find(f => f.id === state.selection.id) || null;
}

function nudgeFurniture(axis, dir) {
  const f = selectedFurniture();
  if (!f) return;
  const item = getItem(f.type);
  if (!item || item.resize === 'fixed') return;
  // Smooth, tiny 1-inch steps for every resizable item — no snapping.
  const stepFt = 1 / 12;
  const cur = axis === 'w' ? f.w : f.d;
  const next = applyResize(item, axis, cur + dir * stepFt, { w: f.w, d: f.d });
  f.w = next.w; f.d = next.d;
  resolveAgainstWalls(f); // grow into open space rather than through a wall
  emit();
}

function updateItemPanel() {
  const sel = state.selection;
  const sizeRow = document.getElementById('ip-size');
  const rotateBtn = itemPanel.querySelector('[data-act="rotate"]');
  if (sel?.kind === 'furniture') {
    const f = state.furniture.find(x => x.id === sel.id);
    const item = f && getItem(f.type);
    if (!item) { itemPanel.hidden = true; return; }
    itemPanel.hidden = false;
    let title = item.label;
    if (item.kind === 'bed') title = `${item.label} · ${bedSizeName(f.w)}`;
    else { const note = sizeNote(item, f.w); if (note) title = `${item.label} ${note}`; }
    document.getElementById('ip-title').textContent = title;
    document.getElementById('ip-w').textContent = formatLength(f.w, state.units);
    document.getElementById('ip-d').textContent = formatLength(f.d, state.units);
    sizeRow.style.display = item.resize === 'fixed' ? 'none' : '';
    rotateBtn.style.display = '';
  } else if (sel?.kind === 'opening') {
    const o = state.openings.find(x => x.id === sel.id);
    if (!o) { itemPanel.hidden = true; return; }
    itemPanel.hidden = false;
    document.getElementById('ip-title').textContent =
      `${o.type === 'door' ? 'Door' : 'Window'} · ${formatLength(o.width, state.units)} wide`;
    sizeRow.style.display = 'none';
    rotateBtn.style.display = 'none';
  } else {
    itemPanel.hidden = true;
  }
}

function rotateFurniture90() {
  if (state.tool === 'furniture' && state.placingFurniture) {
    state.placingRot = (state.placingRot + 90) % 360;
    emit();
  } else if (state.selection?.kind === 'furniture') {
    const f = state.furniture.find(x => x.id === state.selection.id);
    if (f) { f.rot = (f.rot + 90) % 360; emit(); }
  }
}

// Init
unitsSelect.value = state.units;
syncUnitsUI();
view2d.init();
emit();
