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
| `state.js` | Central `state` object + `subscribe`/`emit`; mutators (addWall, addOpening, addFurniture, setScale, replaceWalls, **setDetectedWalls** (preserves+re-homes openings onto new walls, then `healBridges` connects nearby wall ends to floating opening bridges), setDetectedOpenings, **setMLOpenings** (attach-or-bridge), `closePalette`, etc.); `state.paletteOpen` is independent of `state.tool`; `reseedIds()` after load |
| `geom.js` | Pure geometry helpers; unit format/parse; SAT OBB overlap (`obbOverlapMTV`); gap detection (`findGap`); shared constants |
| `furniture.js` | Dependency-free catalog (real dims in feet) incl. wall-mounted items (`mount:'wall'`, `mountH`) + resize metadata + `unitCount`/`applyResize`/`sizeNote` |
| `detect.js` | Wall/opening detection. **Heuristic (dependency-free):** `detectWalls` (threshold → thick-band extraction) + `detectOpenings` (gap classification). **On-device ML (ONNX Runtime Web):** `detectWallsML` (U-Net mask → reuses `wallsFromMask`) + `detectDoorsWindowsML` (YOLOv8n → boxes snapped to same-orientation walls). Heuristic stays as fallback. `DW_DEBUG` logs door placement decisions. |
| `vendor/ort/` · `models/` | Vendored ONNX Runtime Web (WASM, single-thread) + the two `.onnx` models (`walls-v1`, `doors-v2`). Lazy-loaded on first ML use; cache-immutable in `_headers`. Models are trained OUTSIDE this repo — see **`C:\Users\arthu\roomwalk-ml\REFINING.md`**. |
| `pdf.js` | Lazy-loads vendored PDF.js and renders an uploaded PDF page to a PNG data URL so the same image pipeline takes over (`isPdfFile`, `renderPdfToImage`) |
| `collision.js` | Furniture↔wall overlap (`resolveAgainstWalls`), gap auto-fit (`fitBetweenWalls`), wall-item snapping (`snapToWall`/`wallSnapPose`), `isClipping`/`recomputeClips` |
| `view2d.js` | 2D canvas: image/outline, world grid, pan/zoom, wall draw + snap, openings, furniture, scale pick. Renders on `subscribe(draw)` |
| `view3d.js` | three.js scene: segmented walls (selectable), per-room flood-filled floors, openings, furniture proxies, wall-item mounting, OrbitControls, click-drag walk, 3D placement/picking |
| `app.js` | Wires DOM/UI to state and views; calibration modals; save/open; **autosave + undo/redo**; detection + start-from-scratch; keyboard shortcuts; **contextual tool tips** (per-tool one-line popup, dismissed-forever via `localStorage` key `roomwalk.tip-dismissed`) |

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

- **Upload + blueprint outline.** Accepts images (PNG/JPG/etc.) **and PDFs**. PDFs
  are rendered to PNG by the vendored PDF.js (`vendor/pdfjs/`, lazy-loaded on
  first PDF upload) and then go through the same image pipeline; multi-page PDFs
  prompt for the page. The plan is processed so dark lines → light graphite, white
  bg → transparent. Toggle + detail (threshold) + opacity in Advanced.
- **Wall tracing.** Click two points. The draft **straightens to H/V first**
  (within ~10°, `AXIS_SNAP_DEG`) and snaps to an existing corner only if that corner
  lies on the straightened line — so nearby wall endpoints (esp. after ML detection)
  don't yank the wall crooked. Walls render as bright accent strokes.
- **Auto-detect walls — heuristic** (`Advanced → Detect walls`, `detect.js`). Threshold
  the image, keep only *thick long* strokes (rejects text/dimension lines via a
  min-band-thickness test), extract axis-aligned centerlines. Applied via
  `setDetectedWalls` (preserves & re-homes existing doors/windows, same as the ML path).
  Tuned for solid-wall plans; thin double-line plans degrade to manual tracing. This is
  the **primary** wall detector — on clean blueprints it often beats the ML model, so it's
  the un-tagged "Detect walls" button; the ML one below is labelled "(ML, beta)".
- **Build from scratch.** `Start from scratch` (top bar) → a blank 1-ft world
  grid (`state.grid`); walls snap to it and scale is pre-set so dimensions are
  real-by-construction. Lets students with only a 3D/listing render rebuild a
  clean plan. Toggle via `Advanced → Canvas → Snap to grid`. The grid + its snap
  are **scratch-mode only** — they no-op when a blueprint image is loaded, so
  tracing an uploaded plan stays fluid (only H/V axis-straightening applies).
- **Doors / windows.** Place tool snaps to walls; select to move (middle) or
  resize (end-thirds). In 2D, dragging the middle **free-moves** a floating
  (bridge) opening (no auto-snap), and dragging an **end** moves that end freely,
  **snapping it to the nearest wall ending/corner (~14px) or wall line (~12px)** so
  you can fix a badly-generated door by hand. **On release, a floating opening that
  now lies along a real wall (both ends within ~14px) attaches to that wall** so the
  wall segments around it — fixes a window staying buried in solid wall ("won't pop
  up" in 3D); never snaps from afar. Orphaned carrier bridges cleaned up on release.
  3D walls are *segmented* around openings — **any wall an opening lies along is
  cut, not just its assigned host** (`openingsAlongWall`), so a wall placed/drawn
  over a door/window can't hide it; geometry preserved, not transparent. Doors
  brown, windows blue glass.
- **Gap-bridging openings.** Hover a door/window over an open gap between two
  collinear wall ends → it auto-fits, creating a short `bridge:true` wall it
  fills (deleting the opening reopens the gap).
- **Auto-detect doors & windows** (`Advanced → Detect doors & windows`). Gaps in
  the detected walls are candidate openings: a light-ink glass line spanning a
  gap ⇒ window (glass is often drawn lighter than walls, so a 2nd sensitive
  threshold catches it); a narrow empty gap ⇒ door; a wide empty gap ⇒ left open.
  Idempotent (re-running replaces prior auto openings, tagged `auto:true`).
- **On-device ML detection** (`Advanced → ✨ Detect walls`, `✨ Detect doors &
  windows`). Runs two ONNX models **in the browser** (ONNX Runtime Web, WASM —
  no backend, works offline). Walls: a U-Net segmenter → wall mask → reuses the
  heuristic band/snap vectorizer. Doors/windows: a YOLOv8n detector → boxes
  snapped onto the nearest **same-orientation** wall and attached as openings, or
  placed where the model found them (bridge) when no matching wall is there. A
  cleanup pass filters the d/w model's noise: per-class confidence (door ≥0.25,
  window ≥0.40), **oversized detections dropped** (> ~8–9 ft or > 35% of the plan —
  kills wall/dimension lines misread as windows), and single doors standardized to
  ~3 ft (`cleanWidthFt`/`DW_*` knobs at the top of `detect.js`). The
  two buttons are **independent** — "Detect doors & windows" never detects walls;
  it works standalone (placing openings at the detected spots, like the spike) and
  uses your walls only if they already exist. "Detect walls" **preserves existing
  openings** — `setDetectedWalls` re-homes each onto the nearest matching new wall
  so the wall segments around it instead of covering it (order-free; recommended:
  doors/windows first, then walls). The heuristic
  detectors stay as the fallback. ~90% on walls, ~85% on doors/windows; dense
  interior closet clusters need manual cleanup. Models are trained outside this
  repo — see `C:\Users\arthu\roomwalk-ml\REFINING.md`.
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
  collision against walls (doors walkable, windows block) and furniture. On enter,
  `findSpawn()` drops the player at the largest room's centre (not the walls' bbox
  centre, which can land on an interior wall — and since collision has no push-out,
  spawning inside a wall would pin movement while look still works).
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
    click to drop. Works in 2D, 3D, and Walk. After dropping, tool returns to
    **Pan** and nothing is selected, but the **palette stays open** so you can
    pick the next item immediately. Palette visibility is driven by
    `state.paletteOpen` (independent of `state.tool`); the × in the palette
    header calls `closePalette()` to dismiss it. Switching to any non-Items
    toolbar tool also closes the palette. R rotates, Delete removes.
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
  a mount height, and **pass through** floor-furniture and walk collision (they
  sit up out of the way). 2D shows them with a dashed teal outline. Mount height
  is set three ways: the panel **Height ±**, dragging the item up/down the wall in
  3D/Walk (the drag tracks the world Y where the cursor hits the wall, via
  `wallPointFromEvent` → `mountHForHitY`), and on placement it mounts at the
  height you point to.
- **Styling.** Floor material presets (wood/tile/carpet/concrete) + global wall
  colour (`Advanced → Style`); **per-wall** colour (select a wall in 2D *or* 3D);
  **per-room floors** — `view3d` flood-fills the wall-bounded space (walls incl.
  door spans are barriers), greedy-meshes each room's floor, and you click a
  room's floor in 3D to set its material. Floors use a **procedurally drawn**
  canvas texture per style (planks / grout / speckle / mottling — no image files);
  patches get world-space UVs so one shared repeating texture tiles seamlessly
  across them (`setFloorUVs`, 1 unit = `FLOOR_TEX_FT`). Per-room overrides are
  keyed by an interior point so they survive edits; room detection is cached by
  walls+overrides.
- **3D realism.** Warm daylight (warm hemisphere + sun) with ACES tone mapping and
  soft shadows; **baseboards** along every floor-touching wall segment (they break
  at doorways, run under windows); a **ceiling** plane at wall height that's
  single-sided facing down, so orbiting from above culls it (room stays open) while
  it appears overhead in Walk.
- **Drag collision.** Furniture stops at walls *during* a drag (resolve runs each
  frame, not just on release), in 2D and 3D/Walk.
- **Hide objects.** Select any wall, door/window, or furniture item and hit
  **Hide** (the button flips to **Show**). Hidden objects lose all collision, so
  you can stand outside and place wall items on the far interior wall without the
  near wall blocking the view or grabbing the snap. They still render as
  see-through "ghosts" (low opacity) in 3D/Walk and faintly in 2D, so you can see
  they're there and click them in any view to unhide (the panel button reads
  **Show**). `Advanced → Canvas → Show all hidden` reveals everything at once. The
  `hidden` flag persists through save/open and undo/redo.
- **Undo / redo + autosave.** Debounced history (`Ctrl+Z` / `Ctrl+Shift+Z` or the
  ↶ ↷ buttons; a drag coalesces into one step). Autosaves to `localStorage` and
  restores the last session on load; falls back to geometry-only if the embedded
  image exceeds the storage quota.
- **Contextual tool tips.** Small popup near the top of the stage when the
  **Wall**, **Door**, **Window**, or **Items** tool is active — explains
  placement, snapping, gap auto-fit, and how to edit with Pan. Each tip has a ×
  that dismisses it forever (keyed per-tool in `localStorage` under
  `roomwalk.tip-dismissed`), so returning users aren't lectured. Content lives
  in the `TIPS` table in `app.js`; the popup itself is `#tool-tip` in
  `index.html` (styled by `.tool-tip` in `styles.css`).
- **Save / Open.** Save downloads a self-contained `.json` (walls incl. per-wall
  colour, openings, furniture incl. `mountH`, scale, units, grid, floor/wall
  style, per-room floors, AND the floor-plan image as a data URL). Open restores
  everything and reseeds ids.

## Theme

"Foundry workspace" — matched to the FORWARD ops console. Cool navy-charcoal
chassis (`--bg` `#181B22`, `--panel` `#1F232C`, `--panel-2` `#272C37`, border
`#2A2F3A`), single **Foundry blue** accent **`#2F5FE0`** (walls + chrome all use it;
selection / grips use the brighter `#5B8DEF`). Danger is rose `#F0617F`
(kept distinct from the blue accent). Doors brown, windows blue, furniture
neutral slate, clip warnings red, scale-pick guide amber. 2D colors live in the
`PAL` object at the top of `view2d.js`; UI colors in CSS `:root`; the 3D scene
background/fog + selection handles live in `view3d.js`.

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
doors/windows · gap-bridging · build-from-scratch grid · wall-mounted items
(incl. drag-to-set mount height) · floor/wall/per-wall/per-room styling ·
edge-anchored resize · drag collision · undo/redo + autosave · hide objects ·
3D realism (procedural floor textures, baseboards, ceiling, warm lighting) ·
persistent items palette (stays open across drops; × to dismiss) · contextual
per-tool tip popups (dismissed-forever per tool).

Next / ideas:
1. Even richer materials — procedural wall texture / wallpaper, optional crown
   moulding, window reflections. Floors, baseboards, and ceiling are done.
2. Touch / mobile support (currently mouse-only) — separate effort.
3. More item detail — dresser/wardrobe/bookcase/bench/TV stand/shower/wall
   TV now have dedicated proxies; ottoman and the thin wall pieces (shelf,
   mirror, range hood) are still plain boxes. (Crib was removed from the catalog.)
4. OCR auto-reading of printed dimension labels for auto-calibration.
5. Pick walls/rooms in 3D is done; per-room *wall* colour and numeric room entry
   ("add a 12×10 room") would round out reconstruction.

Deferred: importing external glTF/OBJ model files (chose catalog box-proxies).

Big-picture vision (not committed work): see `IDEAS.md`. The headline idea is
**mobile capture**, walking a real room with a phone camera (WebXR / AR) and
drawing the plan in place, then furnishing and walking it with the existing viewer.

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
