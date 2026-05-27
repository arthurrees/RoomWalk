// Furniture & fixture catalog. Dependency-free: just real-world dimensions and
// metadata. Dimensions are in FEET. w = width (local X), d = depth (local Z),
// h = height (Y). The `kind` selects which 3D box-proxy builder view3d uses.
//
// `resize` controls how an item adapts when resized:
//   'units'   – repeats a base unit across the width (unitW feet each); e.g. a
//               sink gains a 2nd basin, a sofa gains cushions. minU/maxU clamp.
//   'stretch' – geometry scales smoothly within [minW,maxW] / [minD,maxD].
//   'snap'    – width snaps to the nearest entry in `sizes` (beds).
//   'fixed'   – standardized, not resizable (appliances, toilet).

const IN = (inches) => inches / 12; // inches -> feet

export const CATALOG = [
  // --- Kitchen appliances ---
  { id: 'fridge',     label: 'Refrigerator', cat: 'Kitchen', kind: 'appliance', w: IN(36), d: IN(30), h: IN(66), color: '#cdd2d8', resize: 'fixed' },
  { id: 'range',      label: 'Stove / Range', cat: 'Kitchen', kind: 'stove',    w: IN(30), d: IN(26), h: IN(36), color: '#c4c8ce', resize: 'fixed' },
  { id: 'dishwasher', label: 'Dishwasher',   cat: 'Kitchen', kind: 'appliance', w: IN(24), d: IN(24), h: IN(34), color: '#cdd2d8', resize: 'fixed' },
  { id: 'counter',    label: 'Counter',      cat: 'Kitchen', kind: 'counter',  w: IN(36), d: IN(25), h: IN(36), color: '#b9a896', resize: 'units', unitW: IN(30), minU: 1, maxU: 6 },
  { id: 'kitsink',    label: 'Kitchen sink', cat: 'Kitchen',  kind: 'counter',  w: IN(33), d: IN(25), h: IN(36), color: '#b9a896', sink: true, resize: 'units', unitW: IN(28), minU: 1, maxU: 3 },

  // --- Bathroom fixtures ---
  { id: 'toilet',  label: 'Toilet',       cat: 'Bathroom', kind: 'toilet', w: IN(20), d: IN(28), h: IN(30), color: '#eef1f4', resize: 'fixed' },
  { id: 'vanity',  label: 'Sink / Vanity', cat: 'Bathroom', kind: 'sink',  w: IN(24), d: IN(20), h: IN(32), color: '#e7eaee', resize: 'units', unitW: IN(26), minU: 1, maxU: 3 },
  { id: 'tub',     label: 'Bathtub',      cat: 'Bathroom', kind: 'tub',    w: IN(60), d: IN(30), h: IN(20), color: '#eef1f4', resize: 'stretch', minW: IN(48), maxW: IN(84), minD: IN(28), maxD: IN(42) },
  { id: 'shower',  label: 'Shower stall', cat: 'Bathroom', kind: 'box',    w: IN(36), d: IN(36), h: IN(78), color: '#dfe6ec', light: true, resize: 'stretch', minW: IN(30), maxW: IN(60), minD: IN(30), maxD: IN(60) },

  // --- Bedroom ---
  { id: 'bed',  label: 'Bed', cat: 'Bedroom', kind: 'bed', w: IN(60), d: IN(80), h: IN(24), color: '#9aa6b2', resize: 'snap', sizes: [
    { w: IN(38), d: IN(75), name: 'Twin' },
    { w: IN(54), d: IN(75), name: 'Full' },
    { w: IN(60), d: IN(80), name: 'Queen' },
    { w: IN(76), d: IN(80), name: 'King' },
  ] },
  { id: 'nightstand', label: 'Nightstand', cat: 'Bedroom', kind: 'table', w: IN(18), d: IN(18), h: IN(24), color: '#a07a52', resize: 'stretch', minW: IN(14), maxW: IN(30), minD: IN(14), maxD: IN(24) },
  { id: 'dresser',   label: 'Dresser',   cat: 'Bedroom', kind: 'box',   w: IN(60), d: IN(18), h: IN(32), color: '#a07a52', resize: 'stretch', minW: IN(30), maxW: IN(84), minD: IN(16), maxD: IN(24) },
  { id: 'wardrobe',  label: 'Wardrobe',  cat: 'Bedroom', kind: 'box',   w: IN(48), d: IN(24), h: IN(72), color: '#946f49', resize: 'stretch', minW: IN(30), maxW: IN(84), minD: IN(20), maxD: IN(30) },

  // --- Living / Office ---
  { id: 'sofa',     label: 'Sofa',        cat: 'Living', kind: 'sofa',  w: IN(84), d: IN(38), h: IN(34), color: '#8f99a6', resize: 'units', unitW: IN(28), minU: 2, maxU: 5 },
  { id: 'loveseat', label: 'Loveseat',    cat: 'Living', kind: 'sofa',  w: IN(58), d: IN(38), h: IN(34), color: '#8f99a6', resize: 'units', unitW: IN(28), minU: 1, maxU: 3 },
  { id: 'armchair', label: 'Armchair',    cat: 'Living', kind: 'chair', w: IN(36), d: IN(36), h: IN(34), color: '#8f99a6', resize: 'fixed' },
  { id: 'coffee',   label: 'Coffee table', cat: 'Living', kind: 'table', w: IN(48), d: IN(24), h: IN(18), color: '#a07a52', resize: 'stretch', minW: IN(30), maxW: IN(72), minD: IN(18), maxD: IN(36) },
  { id: 'tvstand',  label: 'TV stand',    cat: 'Living', kind: 'box',   w: IN(60), d: IN(16), h: IN(24), color: '#3a3d42', resize: 'stretch', minW: IN(36), maxW: IN(90), minD: IN(14), maxD: IN(22) },
  { id: 'dining',   label: 'Dining table', cat: 'Living', kind: 'table', w: IN(48), d: IN(30), h: IN(30), color: '#a07a52', resize: 'stretch', minW: IN(36), maxW: IN(96), minD: IN(28), maxD: IN(48) },
  { id: 'chair',    label: 'Dining chair', cat: 'Living', kind: 'chair', w: IN(18), d: IN(20), h: IN(34), color: '#a07a52', resize: 'fixed' },
  { id: 'desk',     label: 'Desk',        cat: 'Living', kind: 'table', w: IN(48), d: IN(24), h: IN(30), color: '#a07a52', resize: 'stretch', minW: IN(30), maxW: IN(84), minD: IN(20), maxD: IN(36) },
];

export function getItem(id) {
  return CATALOG.find((i) => i.id === id) || null;
}

export const CATEGORIES = ['Kitchen', 'Bathroom', 'Bedroom', 'Living'];

// How many repeating units fit in width w (feet) for a 'units' item.
export function unitCount(item, w) {
  if (!item || item.resize !== 'units') return 1;
  const n = Math.round(w / item.unitW);
  return Math.max(item.minU || 1, Math.min(item.maxU || 6, n));
}

// Clamp a proposed width/depth (feet) per the item's resize rules.
// Returns { w, d } that should be applied.
export function applyResize(item, axis, value, current) {
  const out = { w: current.w, d: current.d };
  if (!item || item.resize === 'fixed') return out;

  if (item.resize === 'snap') {
    // Snap width to the nearest standard size; depth follows.
    let best = item.sizes[0];
    for (const s of item.sizes) {
      if (Math.abs(s.w - value) < Math.abs(best.w - value)) best = s;
    }
    out.w = best.w; out.d = best.d;
    return out;
  }

  if (axis === 'w') {
    const min = item.resize === 'units' ? (item.minU || 1) * item.unitW * 0.7 : (item.minW || item.w * 0.4);
    const max = item.resize === 'units' ? (item.maxU || 6) * item.unitW : (item.maxW || item.w * 4);
    out.w = Math.max(min, Math.min(max, value));
  } else {
    const min = item.minD || item.d * 0.4;
    const max = item.maxD || item.d * 4;
    out.d = Math.max(min, Math.min(max, value));
  }
  return out;
}

// Label suffix for a placed item (e.g. bed size, "2 basins").
export function sizeNote(item, w) {
  if (!item) return '';
  if (item.resize === 'snap') {
    let best = item.sizes[0];
    for (const s of item.sizes) if (Math.abs(s.w - w) < Math.abs(best.w - w)) best = s;
    return best.name;
  }
  if (item.resize === 'units') {
    const n = unitCount(item, w);
    return n > 1 ? `×${n}` : '';
  }
  return '';
}
