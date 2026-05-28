// Main entry: wires DOM UI to state and the 2D/3D views.
import {
  state, subscribe, emit, setTool, setView, setScale, resetAll, reseedIds,
  clearWalls, clearOpenings, clearFurniture, deleteSelection, armFurniture,
  replaceWalls, setDetectedOpenings, toggleHidden, showAllHidden,
} from './state.js';
import { detectWalls, detectOpenings } from './detect.js';
import { wallLengthPx, parseLength, formatLength, formatArea, FT_PER_M, PX_PER_FT_FALLBACK } from './geom.js';
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
  // Welcome card: only on the true blank start (no image, no walls, not yet in grid/scratch mode).
  if (hint2) hint2.style.display = (editing || state.image || state.walls.length || state.grid) ? 'none' : '';
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

// Welcome-card buttons (empty state) reuse the top-bar actions.
document.getElementById('welcome-upload').addEventListener('click', () => fileInput.click());
document.getElementById('welcome-scratch').addEventListener('click', () => scratchBtn.click());

// --- Start from scratch (build on a grid, no floor-plan image needed) ---
const scratchBtn = document.getElementById('scratch-btn');
scratchBtn.addEventListener('click', () => {
  state.grid = true;
  if (!state.scale) setScale(24); // declare 1 grid = 1 ft so dimensions are real-by-construction
  if (state.view !== '2d') switchView('2d');
  if (!state.image) view2d.fitImage(); // center the blank canvas
  setTool('wall');
  gridToggle.checked = true;
  emit();
  toast('Draw walls on the grid. Each square is 1 ft. Click two points per wall.', 4500);
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

function buildProjectData() {
  return {
    app: 'floor-plan-designer',
    version: 1,
    savedAt: new Date().toISOString(),
    units: state.units,
    scale: state.scale,
    wallHeightFt: state.wallHeightFt,
    imageOpacity: state.imageOpacity,
    outlineMode: state.outlineMode,
    outlineThreshold: state.outlineThreshold,
    grid: state.grid,
    floorStyle: state.floorStyle,
    wallColor: state.wallColor,
    roomFloors: state.roomFloors,
    walls: state.walls,
    openings: state.openings,
    furniture: state.furniture.map(({ id, type, x, y, rot, w, d, mountH, hidden }) => ({ id, type, x, y, rot, w, d, mountH, hidden })),
    image: state.image ? { dataUrl: state.image.dataUrl || null, w: state.image.w, h: state.image.h } : null,
  };
}

function saveProject() {
  const blob = new Blob([JSON.stringify(buildProjectData())], { type: 'application/json' });
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

function applyProject(data, doneMsg = 'Project loaded.') {
  state.units = data.units || 'imperial';
  state.scale = data.scale ?? null;
  state.wallHeightFt = data.wallHeightFt ?? 9;
  state.imageOpacity = data.imageOpacity ?? 0.85;
  state.outlineMode = data.outlineMode ?? true;
  state.outlineThreshold = data.outlineThreshold ?? 120;
  state.grid = data.grid ?? false;
  state.floorStyle = data.floorStyle || 'wood';
  state.wallColor = data.wallColor || '#e9e6df';
  state.roomFloors = data.roomFloors || [];
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
  gridToggle.checked = state.grid;
  floorStyleSel.value = state.floorStyle;
  wallColorInput.value = state.wallColor;

  const finish = () => {
    if (state.view !== '2d') switchView('2d');
    view2d.init();      // ensure the 2D canvas is sized before fitting
    view2d.fitImage();
    emit();
    if (doneMsg) toast(doneMsg);
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

// --- Autosave (localStorage) + Undo / Redo ---
const AUTOSAVE_KEY = 'roomwalk:autosave';
const HISTORY_MAX = 60;
let history = [];
let histIndex = -1;
let applyingHistory = false;
let commitTimer = null;

// Snapshot of just the editable geometry/settings — NOT the background image
// (it's large, rarely changes, and undo shouldn't pull the floor plan out).
function editableSnapshot() {
  return JSON.stringify({
    walls: state.walls,
    openings: state.openings,
    furniture: state.furniture.map(({ id, type, x, y, rot, w, d, mountH, hidden }) => ({ id, type, x, y, rot, w, d, mountH, hidden })),
    scale: state.scale, units: state.units, wallHeightFt: state.wallHeightFt, grid: state.grid,
    floorStyle: state.floorStyle, wallColor: state.wallColor, roomFloors: state.roomFloors,
  });
}

function applySnapshot(snap) {
  const d = JSON.parse(snap);
  applyingHistory = true;
  state.units = d.units; state.scale = d.scale; state.wallHeightFt = d.wallHeightFt; state.grid = d.grid;
  state.floorStyle = d.floorStyle || 'wood'; state.wallColor = d.wallColor || '#e9e6df';
  state.roomFloors = d.roomFloors || [];
  state.walls = d.walls; state.openings = d.openings;
  state.furniture = d.furniture.map(f => {
    const it = getItem(f.type);
    return { ...f, w: f.w ?? (it ? it.w : 2), d: f.d ?? (it ? it.d : 2), rot: f.rot || 0 };
  });
  state.selection = null;
  reseedIds();
  unitsSelect.value = state.units; syncUnitsUI(); buildPalette();
  gridToggle.checked = state.grid;
  floorStyleSel.value = state.floorStyle;
  wallColorInput.value = state.wallColor;
  emit();
  applyingHistory = false;
}

function undo() {
  if (histIndex <= 0) { toast('Nothing to undo'); return; }
  histIndex--; applySnapshot(history[histIndex]); autosave();
}
function redo() {
  if (histIndex >= history.length - 1) { toast('Nothing to redo'); return; }
  histIndex++; applySnapshot(history[histIndex]); autosave();
}

function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildProjectData()));
  } catch {
    // Quota exceeded (usually the embedded image) — keep geometry, drop image.
    try {
      const d = buildProjectData();
      d.image = state.image ? { w: state.image.w, h: state.image.h } : null;
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(d));
    } catch { /* give up silently */ }
  }
}

// After edits settle, record ONE history entry + autosave. Debouncing coalesces
// a drag (many emits) into a single undo step.
function commit() {
  const snap = editableSnapshot();
  if (histIndex < 0 || history[histIndex] !== snap) {
    history = history.slice(0, histIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_MAX) history.shift();
    histIndex = history.length - 1;
  }
  autosave();
}

subscribe(() => {
  if (applyingHistory) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 300);
});

function loadAutosave() {
  let raw;
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch { return false; }
  if (!raw) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  const hasContent = data && (Array.isArray(data.walls) && data.walls.length || (data.furniture || []).length || data.image);
  if (!hasContent) return false;
  applyProject(data, 'Restored your last session.');
  return true;
}

const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

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
    else if (a === 'detect-walls') runDetectWalls();
    else if (a === 'detect-openings') runDetectOpenings();
    else if (a === 'clear-walls') { clearWalls(); toast('Walls cleared'); }
    else if (a === 'clear-openings') { clearOpenings(); toast('Doors/windows cleared'); }
    else if (a === 'clear-furniture') { clearFurniture(); toast('Furniture cleared'); }
    else if (a === 'show-hidden') { showAllHidden(); toast('All hidden objects shown'); }
    else if (a === 'reset-all') { if (confirm('Reset everything?')) { resetAll(); toast('Reset.'); } }
  });
});

// Auto-detect walls from the uploaded plan. Replaces the current wall set;
// the user reviews and fixes with the Wall tool, or "Clear walls" to redo
// manually if the plan didn't detect cleanly (thin double-line plans won't).
function runDetectWalls() {
  if (!state.image?.el) { toast('Upload a floor plan first.'); return; }
  toast('Detecting walls…');
  // Defer so the toast paints before the synchronous detection pass runs.
  setTimeout(() => {
    let walls = [];
    try { walls = detectWalls(state.image.el); }
    catch (err) { console.error(err); toast('Wall detection failed. Trace manually with the Wall tool.', 4000); return; }
    if (!walls.length) {
      toast('Couldn’t auto-detect walls on this plan. Trace them manually with the Wall tool.', 4500);
      return;
    }
    replaceWalls(walls);
    if (state.view !== '2d') switchView('2d');
    const n = walls.length;
    toast(`Detected ${n} wall${n === 1 ? '' : 's'}. Review and fix with the Wall tool, or Clear walls to redo manually.`, 5000);
  }, 30);
}

// Auto-detect doors & windows in the gaps between the current walls. Doors get
// a swing arc in the plan, windows have glass lines; gaps with neither are left
// open. Re-runnable (replaces a previous detection's openings).
function runDetectOpenings() {
  if (!state.image?.el) { toast('Upload a floor plan first.'); return; }
  if (state.walls.length < 2) {
    toast('Detect or draw walls first. Doors & windows sit in the gaps between them.', 4500);
    return;
  }
  toast('Detecting doors & windows…');
  setTimeout(() => {
    const pxPerFt = state.scale ?? PX_PER_FT_FALLBACK;
    let items = [];
    try { items = detectOpenings(state.image.el, state.walls, { pxPerFt }); }
    catch (err) { console.error(err); toast('Detection failed. Place doors/windows manually.', 4000); return; }
    if (!items.length) {
      toast('No doors or windows detected. Add them with the Door/Window tools.', 4500);
      return;
    }
    setDetectedOpenings(items);
    if (state.view !== '2d') switchView('2d');
    const d = items.filter(i => i.type === 'door').length;
    const w = items.length - d;
    toast(`Detected ${d} door${d === 1 ? '' : 's'} and ${w} window${w === 1 ? '' : 's'}. Adjust or delete any with the Pan tool.`, 5000);
  }, 30);
}

// Opacity slider
const opacitySlider = document.getElementById('opacity');
opacitySlider.addEventListener('input', () => {
  state.imageOpacity = parseInt(opacitySlider.value, 10) / 100;
  emit();
});

// Floor material + wall colour (whole-home 3D styling)
const floorStyleSel = document.getElementById('floor-style');
const wallColorInput = document.getElementById('wall-color');
floorStyleSel.addEventListener('change', () => { state.floorStyle = floorStyleSel.value; emit(); });
wallColorInput.addEventListener('input', () => { state.wallColor = wallColorInput.value; emit(); });

// Snap-to-grid toggle (1-ft build grid)
const gridToggle = document.getElementById('grid-mode');
gridToggle.addEventListener('change', () => {
  state.grid = gridToggle.checked;
  if (state.grid && !state.scale) setScale(24);
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
    toast('Those points are too close together. Try again.');
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
    fp ? `${formatLength(fp.w, u)} × ${formatLength(fp.h, u)}` : '–';

  const roArea = document.getElementById('ro-area');
  const poly = computeFloorAreaSqft();
  if (poly) {
    roArea.textContent = formatArea(poly, u);
  } else if (fp && state.walls.length >= 3) {
    roArea.textContent = `~${formatArea(fp.w * fp.h, u)}`;
  } else {
    roArea.textContent = state.scale ? 'trace a closed room' : '–';
  }
}

// After calibrating, surface the computed area so the user can cross-check it
// against the listing's stated square footage.
function reportAreaIfPossible() {
  const area = computeFloorAreaSqft();
  if (area) {
    toast(`Floor area ≈ ${formatArea(area, state.units)}. Compare to the listing to verify.`, 4000);
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
  const k = e.key.toLowerCase();
  // Undo / redo (Ctrl/Cmd+Z, Shift+Z or Ctrl+Y to redo).
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey) return; // don't fire tool shortcuts with a modifier held
  if (!modal.hidden) return;
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
    // Esc clears whatever you've grabbed onto: an armed placement, or a selection.
    let changed = false;
    if (state.placingFurniture) { state.placingFurniture = null; changed = true; }
    if (state.selection) { state.selection = null; changed = true; }
    if (changed) emit();
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
  else if (act === 'hide') toggleHidden();
  else if (act === 'rotate') rotateFurniture90();
  else if (act === 'w-') nudgeFurniture('w', -1);
  else if (act === 'w+') nudgeFurniture('w', 1);
  else if (act === 'd-') nudgeFurniture('d', -1);
  else if (act === 'd+') nudgeFurniture('d', 1);
  else if (act === 'h-') nudgeHeight(-1);
  else if (act === 'h+') nudgeHeight(1);
  else if (act === 'wall-reset') setSelectedWallColor(null);
});

// Per-wall colour: set on the selected wall (null clears it → uses the global colour).
const ipWallColor = document.getElementById('ip-wall-color');
ipWallColor.addEventListener('input', () => setSelectedWallColor(ipWallColor.value));
function setSelectedWallColor(color) {
  if (state.selection?.kind !== 'wall') return;
  const w = state.walls.find(x => x.id === state.selection.id);
  if (!w) return;
  if (color) w.color = color; else delete w.color;
  emit();
}

// Per-room floor: store an override at the selected room's interior point.
const ipRoomFloor = document.getElementById('ip-room-floor');
ipRoomFloor.addEventListener('change', () => {
  const sel = state.selection;
  if (sel?.kind !== 'room') return;
  state.roomFloors = (state.roomFloors || []).filter(o => `${Math.round(o.x)},${Math.round(o.y)}` !== sel.key);
  state.roomFloors.push({ x: sel.x, y: sel.y, style: ipRoomFloor.value });
  sel.style = ipRoomFloor.value; // keep the panel in sync
  emit();
});

// Raise/lower a wall-mounted item (its mount height off the floor), 3" per step.
function nudgeHeight(dir) {
  const f = selectedFurniture();
  if (!f) return;
  const item = getItem(f.type);
  if (!item || item.mount !== 'wall') return;
  const cur = f.mountH ?? item.mountH ?? 4;
  const maxH = Math.max(0, state.wallHeightFt - item.h);
  f.mountH = Math.max(0, Math.min(maxH, cur + dir * 0.25));
  emit();
}

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
  const wallRow = document.getElementById('ip-wall');
  const roomRow = document.getElementById('ip-room');
  const deleteBtn = itemPanel.querySelector('[data-act="delete"]');
  const hideBtn = itemPanel.querySelector('[data-act="hide"]');
  wallRow.hidden = sel?.kind !== 'wall';
  roomRow.hidden = sel?.kind !== 'room';
  deleteBtn.style.display = sel?.kind === 'room' ? 'none' : ''; // rooms aren't deletable
  // Hide/Show: walls, openings, furniture (rooms can't be hidden).
  const hideable = sel && sel.kind !== 'room';
  hideBtn.style.display = hideable ? '' : 'none';
  if (hideable) {
    const obj = sel.kind === 'wall' ? state.walls.find(w => w.id === sel.id)
      : sel.kind === 'opening' ? state.openings.find(o => o.id === sel.id)
      : state.furniture.find(f => f.id === sel.id);
    hideBtn.textContent = obj?.hidden ? 'Show' : 'Hide';
  }
  if (sel?.kind === 'wall') {
    const w = state.walls.find(x => x.id === sel.id);
    if (!w) { itemPanel.hidden = true; return; }
    itemPanel.hidden = false;
    document.getElementById('ip-title').textContent = 'Wall';
    sizeRow.style.display = 'none';
    rotateBtn.style.display = 'none';
    document.getElementById('ip-wall-color').value = w.color || state.wallColor || '#e9e6df';
    return;
  }
  if (sel?.kind === 'room') {
    itemPanel.hidden = false;
    document.getElementById('ip-title').textContent = 'Room floor';
    sizeRow.style.display = 'none';
    rotateBtn.style.display = 'none';
    document.getElementById('ip-room-floor').value = sel.style || state.floorStyle;
    return;
  }
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
    // Height control only for wall-mounted items (and force the row visible so it shows).
    const wallMount = item.mount === 'wall';
    const hEl = document.getElementById('ip-height');
    hEl.hidden = !wallMount;
    if (wallMount) document.getElementById('ip-h').textContent = formatLength(f.mountH ?? item.mountH ?? 4, state.units);
    sizeRow.style.display = (item.resize === 'fixed' && !wallMount) ? 'none' : '';
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
if (!loadAutosave()) emit(); // restore last session, else start fresh
