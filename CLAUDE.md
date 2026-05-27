# RoomWalk

Browser-based floor plan designer. Upload a 2D apartment floor plan (or build
from scratch on a grid), trace/auto-detect walls and doors/windows, place
to-scale furniture and wall-mounted items, style floors & walls, then view/walk
the result in 3D. "Sims-like" sandbox feel, not a wireframe tool.

## Running it

No build step. Pure static files (ES modules). three.js is **vendored** under
`vendor/three/` (no CDN dependency), wired via the import map in `index.html`.

```
python -m http.server 5181
# then open http://localhost:5181
```

(Port 5181 used during development; 5173 was taken by another process.)
Hard-reload (Ctrl+Shift+R) after edits to bypass cache.

### Hosting / deploy
- Repo: `github.com/arthurrees/RoomWalk`. Hosted on **Cloudflare Pages** (connected
  to the repo). Push to `main` → auto-deploy in ~30–60s. `wrangler.jsonc` is the
  Cloudflare config (serves repo root as static assets).
- `_headers` sets `Cache-Control: no-cache` on everything so returning visitors
  always revalidate and never get a stale build (files have no version hash).
- Usage analytics: enable Cloudflare Web Analytics on the Pages project.

## Architecture

Vanilla JS, ES modules, three.js **vendored** under `vendor/three/` (no CDN),
wired via the import map in `index.html`. Central state with a tiny pub/sub; the
2D and 3D views both subscribe and re-render on `emit()`.

| File | Responsibility |
|------|----------------|
| `index.html` | Layout: top bar, toolbar, sectioned Advanced dropdown, How-to guide, palette, readout/selection panels, three.js import map |
| `styles.css` | ThinkPad-inspired theme (see Theme below) |
| `state.js` | Central `state` object + `subscribe`/`emit`; mutators (addWall, addOpening, addFurniture, setScale, replaceWalls, setDetectedOpenings, etc.); `reseedIds()` after load |
| `geom.js` | Pure geometry helpers; unit format/parse; SAT OBB overlap (`obbOverlapMTV`); gap detection (`findGap`); shared constants |
| `furniture.js` | Dependency-free catalog (real dims in feet) incl. wall-mounted items (`mount:'wall'`, `mountH`) + resize metadata + `unitCount`/`applyResize`/`sizeNote` |
| `detect.js` | Dependency-free CV: `detectWalls` (threshold → thick-band extraction) and `detectOpenings` (gap classification: light-glass ⇒ window, narrow empty ⇒ door) |
| `collision.js` | Furniture↔wall overlap (`resolveAgainstWalls`), gap auto-fit (`fitBetweenWalls`), wall-item snapping (`snapToWall`/`wallSnapPose`), `isClipping`/`recomputeClips` |
| `view2d.js` | 2D canvas: image/outline, world grid, pan/zoom, wall draw + snap, openings, furniture, scale pick. Renders on `subscribe(draw)` |
| `view3d.js` | three.js scene: segmented walls (selectable), per-room flood-filled floors, openings, furniture proxies, wall-item mounting, OrbitControls, click-drag walk, 3D placement/picking |
| `app.js` | Wires DOM/UI to state and views; calibration modals; save/open; **autosave + undo/redo**; detection + start-from-scratch; keyboard shortcuts |

### Coordinate model
- All geometry (walls, openings, furniture) is stored in **image-pixel
  coordinates** (the uploaded plan's resolution).
- `state.scale` = **pixels per foot**; `feet = pixels / scale`. Until calibrated
  it falls back to the shared `PX_PER_FT_FALLBACK` (12) so 2D and 3D agree.
- 3D uses feet directly: `px2ft(px) = px / scale`. Image x → world x, image y →
  world z, up is +y.
- **Critical:** 2D and 3D must use the same px/ft or openings/furniture render at
  different relative sizes across views.

## Features implemented

- **Upload + blueprint outline.** Image processed so dark lines → light graphite,
  white bg → transparent. Toggle + detail (threshold) + opacity in Advanced.
- **Wall tracing.** Click two points; endpoint snap + horizontal/vertical axis
  snap. Walls render as bright accent strokes.
- **Auto-detect walls** (`Advanced → Detect walls`, `detect.js`). Threshold the
  image, keep only *thick long* strokes (rejects text/dimension lines via a
  min-band-thickness test), extract axis-aligned centerlines → `replaceWalls`.
  Tuned for solid-wall plans; thin double-line plans degrade to manual tracing.
- **Build from scratch.** `Start from scratch` (top bar) → a blank 1-ft world
  grid (`state.grid`); walls snap to it and scale is pre-set so dimensions are
  real-by-construction. Lets students with only a 3D/listing render rebuild a
  clean plan. Toggle via `Advanced → Canvas → Snap to grid`.
- **Doors / windows.** Place tool snaps to walls; select to move (middle) or
  resize (end-thirds). 3D walls are *segmented* around openings (geometry
  preserved, not transparent); doors brown, windows blue glass.
- **Gap-bridging openings.** Hover a door/window over an open gap between two
  collinear wall ends → it auto-fits, creating a short `bridge:true` wall it
  fills (deleting the opening reopens the gap).
- **Auto-detect doors & windows** (`Advanced → Detect doors & windows`). Gaps in
  the detected walls are candidate openings: a light-ink glass line spanning a
  gap ⇒ window (glass is often drawn lighter than walls, so a 2nd sensitive
  threshold catches it); a narrow empty gap ⇒ door; a wide empty gap ⇒ left open.
  Idempotent (re-running replaces prior auto openings, tagged `auto:true`).
- **Scale calibration** (all converge on px/ft):
  1. **Set scale from a dimension** — click two points on the plan, type the real
     length. Clicks snap to the nearest drawn line; also axis-snap.
  2. Click a **wall** in the Scale tool and type its length.
  3. **Calibrate by area** (sq ft / m²) from the traced wall polygon.
- **Units.** Imperial (ft/in, default) or Metric (m) — Advanced dropdown.
  Internal canonical stays feet; only display/parse change.
- **Readout panel** (top-right): px/ft, footprint W×H, floor area — cross-check
  against the listing's stated sq ft.
- **2D / 3D / Walk** views. Walk = click-drag look (NOT pointer lock — that was
  unreliable on Windows/Chromium), WASD/arrows move, Q/E turn, eye height 5'9",
  collision against walls (doors walkable, windows block) and furniture.
- **Furniture & fixtures.** Catalog of appliances (fridge, range, dishwasher,
  counter), bath fixtures (toilet, vanity, tub, shower), and furniture (beds,
  sofa, chairs, tables, desk, dresser, wardrobe, TV stand). Box-proxy 3D
  (stylized; data model allows swapping to glTF later). Fixtures have real
  detail/recesses: vanity & kitchen sinks build a recessed basin (rim + sunk
  well via the `addBasin` helper) + faucet; tub is a hollow shell (floor + 4
  walls, open top) with drain + faucet; toilet has tank + pedestal + bowl + torus
  seat ring + bowl divot; stove has 4 burners + oven handle; fridge/dishwasher
  have a handle (+ door seam on tall units). Bed/sofa/chair/table left simpler.
  - **Placement:** Items tool (shortcut `I`) → palette → click item to arm →
    click to drop. Works in 2D, 3D, and Walk. After dropping, auto-switches to
    Pan with the item selected. R rotates, Delete removes.
  - **Resize behaviors:** `units` items repeat parts (sink→double sink/basins,
    sofa→more cushions, counter→more bays — the dimension stays continuous, the
    sub-count is a render threshold); `stretch` scales; `fixed` (toilet only) can't
    resize. Beds, fridge, range, dishwasher are now `stretch` (smooth). Each placed
    item has its own w/d. **No snapping** — drag handles are continuous and panel
    +/- steps are 1 inch.
  - **Selection panel** (bottom center): W/D steppers (1-inch), Rotate, Delete.
    For a **bed** the title shows the nearest standard size (Twin/Full/Queen/King)
    as you smoothly resize. For openings it shows just Delete + width. Hint pills /
    walk instructions hide whenever something is selected (declutter).
  - **Direct manipulation in 3D & Walk:** click furniture *or* a door/window to
    select; floor/wall-level **drag handles** appear — drag an edge handle to
    resize, drag the body to move (furniture) or slide along the wall (openings).
    A capture-phase pointer pipeline intercepts grabs before OrbitControls; in
    Walk, grabbing a handle/item pauses look-drag (`suppressLook`), and `endManip`
    only re-enables orbit when `view==='3d'` (so editing in Walk doesn't leave
    orbit on and fling the camera). Doors/windows get invisible pick proxies
    (`userData.openingId`); for **doors** the proxy is only the frame (jambs +
    header), so the open doorway doesn't grab the door when walking through.
    All edits write shared state, so the 2D view stays in sync.
- **Collision-aware placement.** On drop / resize / drag-release, items slide out
  of walls into open space (corner bed grown to king expands into the room). On
  **placement**, an item wedged between two walls **auto-fits** — it shrinks the
  squeezed dimension to fit the gap (resizable items only). Items that still
  overlap a wall or another item are flagged with a red dashed outline + ⚠ (2D)
  and a red wireframe box (3D). After dropping, the tool auto-switches to the
  Pan cursor with the new item selected. (Pan is the single all-purpose cursor —
  pan / select / move / resize; there is no separate Select tool.)
- **Wall-mounted items** (`mount:'wall'`, `mountH`): wall cabinet, floating
  shelf, wall TV, medicine cabinet, mirror, range hood (the **Wall** palette
  group). Snap flush to the nearest wall on its *interior* side, render lifted to
  a mount height (adjustable via the panel **Height ±**), and **pass through**
  floor-furniture and walk collision (they sit up out of the way). 2D shows them
  with a dashed teal outline.
- **Styling.** Floor material presets (wood/tile/carpet/concrete) + global wall
  colour (`Advanced → Style`); **per-wall** colour (select a wall in 2D *or* 3D);
  **per-room floors** — `view3d` flood-fills the wall-bounded space (walls incl.
  door spans are barriers), greedy-meshes each room's floor, and you click a
  room's floor in 3D to set its material. Approximated with colour + roughness
  (no image textures). Per-room overrides are keyed by an interior point so they
  survive edits; room detection is cached by walls+overrides.
- **Drag collision.** Furniture stops at walls *during* a drag (resolve runs each
  frame, not just on release), in 2D and 3D/Walk.
- **Hide objects.** Select any wall, door/window, or furniture item and hit
  **Hide** (the button flips to **Show**). Hidden objects vanish from 3D/Walk and
  lose all collision, so you can stand outside and place wall items on the far
  interior wall without the near wall blocking the view or grabbing the snap. In
  2D they stay faintly drawn (alpha 0.22) so they're still selectable to unhide.
  `Advanced → Canvas → Show all hidden` reveals everything at once. The `hidden`
  flag persists through save/open and undo/redo.
- **Undo / redo + autosave.** Debounced history (`Ctrl+Z` / `Ctrl+Shift+Z` or the
  ↶ ↷ buttons; a drag coalesces into one step). Autosaves to `localStorage` and
  restores the last session on load; falls back to geometry-only if the embedded
  image exceeds the storage quota.
- **Save / Open.** Save downloads a self-contained `.json` (walls incl. per-wall
  colour, openings, furniture incl. `mountH`, scale, units, grid, floor/wall
  style, per-room floors, AND the floor-plan image as a data URL). Open restores
  everything and reseeds ids.

## Theme

ThinkPad-inspired: matte near-black (`#16171A`), graphite reference lines, single
red accent **`#E2232A`** (selection `#FF3B43`). Doors brown, windows blue,
furniture neutral slate, clip warnings red, scale-pick guide amber. 2D colors
live in the `PAL` object at the top of `view2d.js`; UI colors in CSS `:root`.

## Conventions / gotchas

- Re-render by mutating `state` then calling `emit()`. Don't render imperatively.
- `state.image` carries `{ el, w, h, outline, dataUrl }`. `dataUrl` enables Save.
- `_clip` is a transient flag on furniture (recomputed each render; stripped on save).
- Walk uses its own mouse handlers; 3D furniture placement uses a **capture-phase
  pointerdown** to intercept grabs before OrbitControls.
- Furniture rotation/Escape are handled in `app.js` keydown (any view); avoid
  duplicating in `view2d.js`.

## Roadmap

Done: adaptive resize · direct 3D/Walk manipulation · auto-detect walls &
doors/windows · gap-bridging · build-from-scratch grid · wall-mounted items ·
floor/wall/per-wall/per-room styling · edge-anchored resize · drag collision ·
undo/redo + autosave.

Next / ideas:
1. Richer materials (procedural wood grain / tile lines, optional ceiling &
   baseboards) — the box-proxy look is still flat.
2. Touch / mobile support (currently mouse-only) — separate effort.
3. More item detail — dresser/wardrobe/bookcase/bench/TV stand/shower/wall
   TV now have dedicated proxies; ottoman and the thin wall pieces (shelf,
   mirror, range hood) are still plain boxes. (Crib was removed from the catalog.)
4. OCR auto-reading of printed dimension labels for auto-calibration.
5. Pick walls/rooms in 3D is done; per-room *wall* colour and numeric room entry
   ("add a 12×10 room") would round out reconstruction.

Deferred: importing external glTF/OBJ model files (chose catalog box-proxies).

## Deploy status

Live on Cloudflare Pages (`roomwalk.pages.dev`), repo `github.com/arthurrees/RoomWalk`.
three.js vendored locally; `_headers` sets no-cache; `wrangler.jsonc` serves root.
Push to `main` → auto-deploy. Cloudflare Web Analytics available on the project.

## Example floor plans

Top-down test images live in `example floorplans/` (316 Gunson, 609 Grand River,
513 Hillcrest, 920 Ann, Chalet, Lodges). Most print dimensions; doors are
consistently 3'-0" — which is why dimension-line calibration is primary and a 36"
door is the standards fallback. 316 Gunson (solid thick walls) is the auto-detect
happy path; Lodges (thin double-line walls) is the graceful-fallback case.

`example floorplans/new floorplans/` holds the *hard* real-world cases students
actually find: 3D dollhouse / isometric renders (Cedar Village, Red Cedar Flats)
that **can't** be traced top-down, plus a colored top-down plan (`slide.jpg`).
The renders are why **Build from scratch** exists — you can't auto-detect a
perspective image, so you rebuild on the grid using it as a visual reference.
