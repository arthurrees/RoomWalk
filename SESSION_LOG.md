# RoomWalk — session log

Most recent first. Resume point if a chat disconnects.

---

## 2026-07-23 — Live application redesign + automatic ML import workflow

**Redesign shipped in the working tree.** The approved standalone concept was
carried into the real app while preserving the existing canvas/state/3D engine:

- `index.html` now uses a warm architectural-workspace shell: compact top bar,
  deep-ink left creation rail, central 2D/3D/Walk switcher, and a persistent
  right-side **Plan overview** inspector.
- `styles.css`, the `view2d.js` `PAL`, and the `view3d.js` scene background/fog
  now share paper `#F7F5EF`, ink `#24342F`, sage `#287F6A`, and coral `#DF725B`.
- The right inspector contains:
  - Plan summary (area, footprint, px/unit scale).
  - Both existing scale paths: total sq ft/m² and known wall/dimension.
  - Automatic-detection status plus manual ML retries and standard-wall fallback.
  - Canvas appearance (units, height, opacity, grid, show hidden).
  - Remove doors, Remove walls, and Remove everything.
- `state.clearDoors()` removes doors only, cleans now-unused auto bridge walls,
  and preserves windows plus structural walls. Remove walls uses the existing
  `clearWalls()` behavior (attached openings also clear); Remove everything uses
  `resetAll()`. Destructive actions confirm first.

**Automatic import detection:** `loadImageDataUrl()` now calls
`runAutomaticMLDetection(img)` after the new image is fitted/emitted. The sequence
is the existing `detectWallsML()` first, then the existing
`detectDoorsWindowsML()` against those walls. If ML returns no walls, the existing
heuristic `detectWalls()` remains the fallback. Async results are discarded if a
newer image replaces the import while inference is running.

**ML safety invariant:** `detect.js`, `models/walls-v1.onnx`,
`models/doors-v2.onnx`, and `vendor/ort/` were **not edited**. End-to-end browser
verification uploaded `example floorplans/lodges_example.png`; the unchanged
models produced **21 structural walls, 10 doors, and 6 windows** in ~2.1 seconds
with no console/resource errors. The resulting geometry built successfully in 3D.

**Scale/removal verification:**
- Area calibration set a non-null scale from 724 sq ft.
- Known-wall calibration set 14.9 px/ft through the existing wall-scale event.
- Remove doors left all 6 windows and 21 structural walls.
- Remove walls cleared walls/openings but kept the imported image.
- Remove everything cleared the image, scale, walls, and openings.
- DOM contract check: 71 unique IDs, every static `getElementById` reference
  present, no duplicate/missing IDs. JS syntax and `git diff --check` pass.

**Copy preference (standing):** avoid filler microcopy, decorative reassurance,
and unnecessary little sub-explanations. Keep functional instructions, live
results, and destructive warnings. The welcome/help privacy reassurance
(“Detection happens privately on this device” / equivalent) was removed. Do not
restore that style of copy.

**Preview artifact:** `index-redesign-preview.html` remains an untracked,
self-contained concept file. The real application is `index.html`.

---

## 2026-06-19 — Heuristic wall detector restored as a separate option; theme finalized

**Two "Detect walls" options now** (user finds the pre-ML heuristic detects better on
clean plans). Advanced → Detect:
- `Detect walls` → `runDetectWallsHeuristic()` — the dependency-free `detectWalls`
  (threshold → thick-band extraction), un-tagged = the primary/recommended one.
- `✨ Detect walls (ML, beta)` → `runDetectWallsML()` — the ONNX path (unchanged).
Both apply via `setDetectedWalls` (preserve + re-home existing openings). Doors/windows
button unchanged. Wired in the `data-action` dispatch; heuristic handler mirrors the ML
one minus the model download + "(beta)" wording.

**Theme finalized:** kept **dark Foundry only** — removed the light/dark toggle
(theme-select, light CSS block, `setTheme` exports in view2d/view3d, `applyTheme` in
app.js all gone; `--glass` var kept for the floating panels). **Blue corrected** to the
true FORWARD `#2F5FE0` everywhere (walls were a lighter `#3F72EF` and looked off);
selection/grips use brighter `#5B8DEF` (2D + 3D). Favicon + CLAUDE.md theme section updated.

---

## 2026-06-19 — Foundry reskin + light/dark theme toggle (uncommitted)

Reskinned RoomWalk from the ThinkPad red/near-black to the **FORWARD "Foundry workspace"**
look, then added a **light/dark toggle** (Advanced → Theme; default dark).

- **Dark (default):** cool navy-charcoal chrome (`--bg #181B22`, `--panel #1F232C`,
  `--panel-2 #272C37`, border `#2A2F3A`), **Foundry blue accent `#2F5FE0`** (was red),
  rose danger `#F0617F`. 2D walls/grips blue (`#3F72EF`/`#7DA6FF`), 3D scene bg navy,
  selection handles/ghost blue. Favicon recoloured blue.
- **Light = true FORWARD replica:** `#F7F8FB` surface, white cards, blue accent, FORWARD
  ink/line/status colours. 2D canvas + grid + walls switch to a light palette; 3D scene
  backdrop → `#F7F8FB`.
- **How it's wired:** theme isn't just CSS — the 2D palette (`PAL`) and 3D scene bg live
  in JS. `:root` = dark, `:root[data-theme="light"]` overrides. New `--glass` var routes
  all floating panels/pills (palette, item-panel, readout, tool-tip, hint, walk HUD) so
  they flip light/dark. `view2d.js` has `PAL_DARK`/`PAL_LIGHT` + `export setTheme`;
  `view3d.js` `export setTheme` sets scene.background/fog (continuous render loop repaints).
  `app.js applyTheme(theme)` sets `<html data-theme>`, calls both view setThemes, persists
  to `localStorage['roomwalk.theme']` (global pref, NOT in the project save file).
- **Theme control:** `<select id="theme-select">` in Advanced → Canvas.

Caveat: 3D **lighting is unchanged** (warm daylight tuned for dark). In light mode the
off-white walls on a light surface are lower-contrast; shadows/baseboards carry it. Tune
hemisphere/ambient later if the light 3D feels washed. All JS parses; served live on :5181.

---

## 2026-06-19 — Pre-launch polish + tablet/touch first pass (uncommitted)

**Pre-launch polish (done):**
- **Detection-debug checkbox hidden in public build.** `index.html` debug row now
  `id="debug-detect-row" hidden`; `app.js` reveals it only on localhost/127.0.0.1/[::1]
  or with `?debug` in the URL. Stays available for dev, invisible to visitors.
- **Vendor caching broadened.** `_headers`: `/vendor/ort/*` → `/vendor/*` so three.js +
  PDF.js get the same 1-year immutable cache as ORT (all pinned by filename).
- **Attribution / licensing (the CC BY must-have).** Added a **Credits** `help-section`
  at the bottom of the How-to dropdown: three.js (MIT), ONNX Runtime Web (MIT), PDF.js
  (Apache 2.0), and Roboflow CC BY 4.0 training data. CSS: `.help-section a` accent links
  + `.credits` muted heading.
- **CLAUDE.md re-checked — already accurate** (walls-v1/doors-v2; only OCR mention is a
  future *idea*). No change needed; the earlier "stale" note in this log is now obsolete.
- **Example floorplans:** left in place (not referenced in code; harmless dead weight).
  Decision deferred — could later wire them in as "try a sample plan" buttons.

**Tablet / touch — first pass (user chose "tablet-first, pragmatic"):**
- **2D editor now works on touch.** Non-invasive touch shim in `view2d.js` (after the
  wheel handler): ONE finger is translated into the existing `mousedown/move/up`
  handlers via synthetic `MouseEvent`s (so ALL draw/select/drag logic is shared, nothing
  forked); TWO fingers pinch-to-zoom around the midpoint (reuses the wheel zoom math) +
  pan by midpoint travel. State machine `touchMode` = single | pinch | rest | null;
  second finger ends an in-progress single drag cleanly. `canvas { touch-action: none }`
  in CSS stops the browser hijacking gestures.
- **3D works on touch already** (OrbitControls is touch-native; furniture grab uses
  pointer events). Left as-is.
- **Walk mode = still desktop-only** (look uses mouse events, movement is WASD; no
  on-screen controls). Deliberately deferred per the pragmatic scope.
- **Responsive layout** (`styles.css` @media ≤1024px): top bar wraps instead of
  overflowing, bigger tap targets (tools/ghost buttons/menu rows/palette/steppers),
  dropdowns scroll (`max-height:70vh`), esc-hint hidden (keyboard-only).
- **Phone notice** (≤640px): one-time dismissible "best on a bigger screen" overlay
  (`#smallscreen-note`), dismiss persists in `localStorage` key
  `roomwalk.smallscreen-dismissed` (same pattern as tool tips).

**Verified:** `node --input-type=module --check` passes on view2d.js + app.js; dev server
:5181 serves all new HTML/CSS/JS. NOT yet tested on a real touch device or committed.

**NEXT:** (1) test on an actual tablet — single-finger draw/select, pinch zoom/pan, 3D
orbit; (2) the still-open launch GATE = commit + push to `main` (auto-deploys Cloudflare
Pages); (3) optional: on-screen Walk controls for full phone support (the bigger lift we
deferred); (4) decide example-floorplans shipping.

---

## 2026-06-18 — WRAP-UP (end of session) + pre-launch checklist

**Where the app stands tonight (working, all uncommitted):**
- **Detection:** walls-v1.onnx (512px) + doors-v2.onnx (640px) — the original pair the user
  preferred. The whole retrain effort (walls-v2, doors-v3/v4, clutter aug, OCR) was tried,
  measured, and BACKED OUT; none beat the originals in real use. Simple vectorizer (morphClose
  + lowered stub threshold reverted). Detect order in Advanced: doors/windows first, then walls.
- **Editing (the wins that stuck):** doors/windows are mutable in 2D (move + resize, magnetic
  corner-clip, door is source of truth, walls bend to meet them at clean right angles). Walls
  are mutable in 2D too: drag a wall body to move it perpendicular (neighbours stretch), drag a
  single endpoint to move just that point — all axis-locked so nothing goes diagonal.
- **Tools:** wall/door/window are 2D-only (hidden in 3D/Walk). Pan + Items everywhere.
- **Scale:** manual only (sq ft, or size a selected wall) — OCR auto-scale scrapped.
- **UI/docs:** three top dropdowns — How to use (Getting around + 3 setup steps), Design
  (furnish / recolour / hide / delete / view+walk), Shortcuts (keybinds). All in the user's
  voice, no em dashes. HEAL_DEBUG flipped to false; DW_DEBUG already false.

**NEXT STEPS (pre-launch / public release):**
1. **[GATE] Commit + push to `main`** — nothing is deployed yet; everything (12 paths incl.
   untracked models/, vendor/ort/, SESSION_LOG.md) is uncommitted. Push triggers the Cloudflare
   Pages build. This is the actual "make public" step.
2. **Mobile / touch** — app is mouse-only; phones get a rough experience. Decide: accept
   desktop-first, or add a "works best on desktop" note on small screens.
3. **Attribution / licensing** — the ONNX models are trained on CC BY Roboflow datasets (CC BY
   requires attribution when shipped). Add a credits line (How-to footer or README) + keep the
   three.js (MIT) / ONNX Runtime (MIT) / PDF.js (Apache-2.0) notices in vendor/.
4. Optional polish: hide the "Show detection debug" checkbox from public build; add `/vendor/*`
   immutable cache in `_headers` (only /vendor/ort/* is cached now); update stale CLAUDE.md
   (still describes walls-v2/doors-v3/OCR experiments we reverted); consider not shipping the
   `example floorplans/` test images.
5. Smoke-test on the live build: detect-with-no-walls then scale (should toast); Save→Open
   round-trip with new wall/opening edits; walk-mode collision after wall edits; very large
   plan upload (canvas memory); model-download failure → heuristic fallback for walls, toast for doors.

Note: first detection downloads ~45 MB (walls + doors models + ort wasm); buttons warn the
user, and it degrades gracefully if the download fails.

---

## 2026-06-18 — In-app ML placement debug overlay

Goal for this session: refine how ML-detected outlines are PLACED on the plan
(the known lossy step). Step 1 = build a visual feedback loop so we stop tuning
`attach/bridge/drop` blind from console logs.

**Shipped (uncommitted):**

- **Detection debug overlay** (`Advanced → Canvas → Show detection debug`,
  `state.debugDetect`). Draws the last ML door/window run on top of the 2D plan:
  - the **raw model box** (dashed, coloured by class; faint if it was dropped),
  - the **placement decision** per box — `attach`: a line from the box to the
    point on the wall it snapped to + a green dot there; `bridge`: the orange
    floating bridge wall it was dropped onto; `DROP`: a red X,
  - a label `type conf decision` above each box.
- Plumbing: `detect.js` now exports a mutable `detectDebug` object; the d/w
  detector records each decision in NATIVE px (`bx1..by2` box, `placeX/placeY`
  attach point, `seg` bridge) and publishes `detectDebug.dw` at the end of a run
  (cleared up front so a no-hit re-run blanks the overlay). `view2d.js`
  `drawDetectDebug()` renders it inside the world transform; `dbgLabel()` draws
  crisp screen-space text. Toggle wired in `app.js`.
- **Caveat:** the overlay shows decisions **pre de-dup**, so a box marked
  attach/bridge here may have been collapsed by the near-coincident de-dup and not
  actually be in `state.openings`. That over-detection is itself useful to see.

**Fix — walls angling toward doorways (`healBridges`, state.js):** the old healer
moved a flanking wall's endpoint TO the door bridge's endpoint, which sat up to
PERP(8)px off the wall's line, tilting the wall (its "collinear, no diagonal"
comment was wrong). Rewritten: iterate bridges, find the nearest collinear
same-orientation wall end within REACH/PERP, then **slide the whole door/window
bridge sideways onto the wall's line** and **extend the wall straight along its own
axis** to meet it. Wall stays perfectly straight; the opening lands exactly on it.
Chose this over generating a tiny perpendicular connector stub (cleaner in 3D).

**Fix — close remaining door↔wall gaps (`healBridges` v2, state.js):** angle is gone
but small gaps remained (door floating just off a near wall). Generalized the heal to
two pure-H/V cases: COLLINEAR (door in line with a flank) — looser tolerances now
14px off-line / 48px along, door slides onto the wall line + wall extends to it; and
CORNER/T (a perpendicular wall stub ends near the door's end) — both meet at their
right-angle intersection (wall extends along its axis, door end along its axis), gated
to ≤22px each so it only welds genuinely-close stubs, never a far wall. No angles
possible (every move is along an axis). Goal: clean apartment plans end up with
nothing left floating.

**Fix — weld EVERY floating door to its nearest wall (`healBridges` v3, state.js):**
v2 worked on one door but not its neighbour (target wall just past the fixed reach,
or needed a T-into-wall-body match v2 didn't have). Replaced the per-case distance
gates with a single NEAREST-WALL search: each floating door/window end scores every
real wall by total px moved (perpendicular slide + wall growth) and welds to the
cheapest within MAX=120px (~10 ft sanity cap, not a tuning knob). One rule now covers
collinear (slide onto line + grow wall), T-into-body (door end to wall face, no grow),
and corner (door to wall line + wall grows to door line). All moves are axis-aligned →
never an angle. `growX/growY` only extend when the target is past the wall's span (so
meeting a wall's body never shrinks it). Matches the user's ask: every spawned door
attaches to the closest wall, even a stub jutting out.

**Refine — stop walls jutting out (`healBridges` v3.1, state.js):** v3 connected
everything but let walls STRETCH toward floating doors, so a wall could jut past the
real plan and the door then met it at a midpoint / a wall grew into the door's body.
Split each candidate's cost into doorMove (door shifts to the wall) vs growth (wall
stretches to the door): growth now HARD-CAPPED at 22px (over that → candidate skipped)
and weighted 4× in the cost, so "door moves onto existing wall" wins and walls keep
their detected length (only a small drawn-slightly-short correction allowed). Possible
follow-up if doors still T into a wall's middle next to a corner: snap the connection
to the nearby wall endpoint.

**Reframe — door/window is the source of truth (`healBridges` v4, state.js):** user
clarified the priority: the OPENING must never move or resize; the WALLS accommodate it
(v3.x was sliding/resizing doors onto walls — the "chunked" look). Rewritten so for each
door jamb, the nearest real wall is made to PASS THROUGH that jamb while staying
axis-aligned: a horizontal wall sets its line to the jamb's y and extends its end to the
jamb's x; a vertical wall sets x and extends to y. The opening is left untouched. Wall
movement = sideways shift (≤SHIFT_CAP 18px) + axial extend (≤GROW_CAP 26px), capped so a
wall only corrects "drawn a few px short/off", never travels to chase a door. Possible
follow-up: connect BOTH a collinear flank AND a perpendicular wall at a true corner
(currently one wall per jamb).

**Decision — fix detection, not placement (2026-06-18):** after iterating
healBridges, user chose to improve the ML models so geometry comes out right and
needs less healing (closet/interior weak spot = REFINING.md #1/#2). Also fixed the
real "doors not attaching" bug: `setDetectedWalls` re-home guard was too strict — a
door plainly on a wall (dist ≤7px) now attaches to the nearest one even if a parallel
face is right behind it (was leaving it a floating bridge ON TOP of the wall). 

**Retraining BOTH models (in `C:\Users\arthu\roomwalk-ml\`, ollama paused for VRAM):**
- **Walls:** train.py loss CrossEntropy → CE + Tversky(alpha .3/beta .7) "combo loss"
  to punish missed-wall false negatives → lifts thin/short interior-wall RECALL. Free
  at inference (same arch/size/512px). Running 60 epochs → export as `walls-v2.onnx`.
- **Doors/windows:** train_dw.py YOLOv8n → YOLOv8s, imgsz 640 → 800 (small closet
  doors are tiny objects; res is the biggest small-object recall lever), batch 12, run
  name `dw_v3`. export_dw.py → `doors-v3.onnx` at imgsz 800.

**Accuracy-over-speed (user, 2026-06-18):** OK with slower in-browser ML load.
→ wall model bumped to **768px** input (was 512) for better thin/short interior-wall
recall — retrained at 768, batch 4 to fit the 8 GB 3070. App `ML_SIZE` must become 768.

**Perf fix — 768px epochs were crawling (>14 min/epoch, GPU-starved):** train.py had
`num_workers=0` (single-thread data loading) + batch 4. Added `--workers 6` (parallel
DataLoader, pin_memory, persistent_workers) + **AMP mixed precision** (torch.amp
autocast + GradScaler) → ~2× faster, ~half activation VRAM, so batch back to 8. No
accuracy cost (fp32 master weights). Relaunched: 768px / batch 8 / workers 6 / AMP.
Baseline to beat (eval_walls.py on 77 test plans): **walls-v1 recall 0.843, prec 0.916,
IoU 0.782, dice 0.878** — goal is recall ↑ without precision crashing.

**WALLS-v2 SHIPPED + verified (2026-06-18):** trained 640px / combo loss / AMP, early
-stopped best val 0.0941. eval_walls.py on 77 held-out plans — a clean win:
  - recall  0.843 → **0.945** (+0.102; missed wall pixels 16% → 5.5% — the thin/interior
    closet walls we were after)
  - precision 0.916 → 0.868 (expected small dip from the recall push; not a crash)
  - IoU 0.782 → **0.826**, dice 0.878 → **0.905** (both up → unambiguously better overall)
  Shipped: copied to app `models/walls-v2.onnx`; detect.js `ML_MODEL_URL` → walls-v2,
  `ML_SIZE` 512 → **640**. (768 was abandoned — OOM/thrash on the 8 GB card; 640 fits and
  the combo loss is the main recall lever anyway.) LIVE — hard-reload to test.

**DOORS-v3 training now** (YOLOv8s, imgsz 800, batch 12, run dw_v3) → export doors-v3.onnx.

**PENDING app-side edits (after doors-v3 exports, else 404 on reload):**
- detect.js `DW_MODEL_URL` → `/models/doors-v3.onnx` AND `DW_SIZE` 640 → **800** (must
  match the new training imgsz or boxes mis-scale)
- update CLAUDE.md model refs; eyeball with diagnose_overlay.py / test_gunson.py
- consider deleting now-unused models: walls-v1.onnx, doors-v1/v2.onnx, spike-mnist,
  walls-v1.int8 (see earlier dead-weight finding)

**Closet still rough after walls-v2 → cheap vectorizer pass + synthetic clutter aug
(2026-06-18, user: "fine-tune as much as possible, no rush, do it correctly"):**
- Diagnosed via diagnose_overlay.py (now points at walls-v2/640): the wall MASK already
  captures closet walls well — the loss is in VECTORIZING the cluttered region. App
  fixes in detect.js: `morphClose` on the ML mask (rejoin broken stubs) + looser
  short-stub threshold (`wallsFromMask` minLenFrac 0.04 → 0.028 for the ML path only).
- Root cause of "things confusing it" = dimension lines / room text / door swing arcs
  (clutter) + style distribution. Chosen fix: **synthetic clutter augmentation** (no
  manual labeling). New `roomwalk-ml/clutter.py` overlays randomized dimension lines+
  ticks, numeric/room text, and swing arcs onto training images WITHOUT changing labels
  → models learn these aren't walls/doors. Visually validated (runs/diag/clutter_preview.png).
  - Walls: wired ONLINE into train.py Dataset (clutter_p=0.6, train only).
  - Doors: ONLINE isn't possible in YOLO → `add_clutter_dw.py` bakes cluttered copies
    (labels copied) into data/dw_clutter_extra + writes data/dw_aug.yaml (trains on
    originals + copies). `train_dw.py --aug` → run dw_v4; `export_dw.py --run dw_v4 --out doors-v4.onnx`.

**Planned GPU sequence (no rush; one at a time, 8 GB card):**
1. [REVERTED] dw_v3 = YOLOv8s@800. Scored HIGHER on Roboflow val (mAP50 .85 vs .81) but
   REGRESSED on real plans — `eval_dw_plans.py` on the examples: 316 Gunson 4d→**2d**
   (missed closet doors), mixed elsewhere. Bigger model overfit the training style →
   worse OOD. **Reverted app to doors-v2 (nano@640)**; detect.js back to `doors-v2.onnx` /
   `DW_SIZE` 640. doors-v3.onnx left in models/ but unused. **LESSON: val mAP ≠ real-plan
   quality; judge door models with `eval_dw_plans.py` on the example plans.**
2. [REJECTED] walls-v3 = walls + ONLINE clutter. Stopped at ep14 (best ep8). eval_walls
   vs walls-v2: recall .945→.953 (+) but precision .868→.852, IoU .826→.818, dice .905→.900
   (all slightly worse); closet overlay on 316 Gunson = visually IDENTICAL to v2. FAILED the
   gate → discarded, walls-v2 kept. **Insight: the WALL model already ignores clutter (clean
   mask); clutter aug had nothing to fix. The closet wall gap was a VECTORIZER issue, already
   handled (morphClose + stub threshold). So clutter only matters for the DOOR model.**
3. [REJECTED] dw_v4 = NANO@640 + clutter (3171 cluttered copies, 6342 train imgs). Stopped
   ep21 (best ep18, val mAP50 ~0.80). `eval_dw_plans.py` doors-v2 vs doors-v4 on the example
   plans: 316 Gunson 4d→5d (+1) BUT 513 Hillcrest 7→4, 920 Ann 7→**2**, 609 5→4, Lodges 11→10
   — NET REGRESSION. **Insight: door symbols are drawn WITH swing arcs, so "ignore arcs"
   taught it to suppress real doors.** FAILED gate → discarded, doors-v2 kept (app already
   on doors-v2). doors-v4.onnx copied to models/ but unused (clean up).

**OUTCOME: both clutter experiments failed their gates. Synthetic clutter doesn't help
here (walls already ignore it; doors co-occur with arcs so it backfires). Final ML state =
walls-v2 + doors-v2 (both verified). Only further ML lever = REAL labeled data of the
upload styles (deferred). Closet fallback = vectorizer fix + manual Wall tool.**
Dead model files to delete: walls-v1*, walls-v3*, doors-v1, doors-v3, doors-v4, spike-mnist,
walls-v2.int8 (app uses walls-v2.onnx + doors-v2.onnx only). data/dw_clutter_extra + dw_aug.yaml removable.

**CLEANUP DONE (2026-06-18):** app `models/` trimmed to ONLY walls-v2.onnx (23MB) +
doors-v2.onnx (12MB) — deleted doors-v1/v3/v4, walls-v1(.int8), spike-mnist, AND the
`test_ml.html` spike (it was the only thing referencing walls-v1). models/ 134MB → 35MB.
All edited JS parses; dev server up :5181. NOT committed yet — user testing the
verified-good state first (walls-v2 + doors-v2 + heal/vectorizer/overlay fixes), commit after.
(roomwalk-ml training workspace left as-is — scratch, reproducible, outside the repo.)

**ML paused (good-enough): walls-v2 + doors-v2 shipped, clutter/yolov8s rejected.
Switched to EDITING polish — door/window manipulation (2026-06-18).**

**Fix — free-move + corner clip for openings (2D, `view2d.js` opening-move):** old logic
was split — a door ON a real wall was LOCKED to sliding along it (couldn't move freely),
and a floating door free-moved with NO snap. Unified: dragging a door's middle now always
rides a carrier bridge during the drag and **magnetically snaps onto the nearest real wall
within ~14px, CLAMPED to the wall's span so it clips at corners/endpoints**; otherwise it
floats free at the cursor (orientation captured at grab via `dragging.horiz`). On release
the existing mouseup logic re-attaches it to the wall it lies on. mouseup orphan-bridge
cleanup broadened to drop ANY unused bridge (carriers are now spun up mid-drag, not just
auto ones). User choice: "magnetic only when close" (no snap-from-afar), 2D first.
3D/Walk opening move not yet changed. Resize (end-drag) unchanged.

**Fix — door "fills the entire wall" on drop (view2d.js mouseup attach):** the attach
recomputed o.width from the bridge ends projected onto the wall; if the door overhung the
wall (short/stray "jutting" wall) the projections clamped to the wall ends → door stretched
to fill the whole wall. Now: PRESERVE the door's width on attach and just clamp its center
within the span (clips at the corner). Also: opening-move only snaps to real walls ≥0.6×
the door width, so a short stray wall can't capture the door.

**Phantom wall regression (user: "wall detector detecting a wall that isn't there,
jutting out halfway; didn't used to be the case; may have overcomplicated it"):**
REVERTED the cheap-pass vectorizer additions in detect.js — removed `morphClose` and
restored `wallsFromMask` minLen to 0.04 (was 0.028 + close). Wall vectorizer back to the
simple known-good version. If phantom persists → it's walls-v2's lower precision
(0.916→0.868); fallback = swap detect.js `ML_MODEL_URL` back to walls-v1.onnx (restore
from roomwalk-ml) for higher precision / fewer false walls (costs some closet recall).
Door/window side reported fine — leave doors-v2 + the opening-move work alone.

**REVERTED to walls-v1 (user: "V1 wall detection was better than V2").** Restored
walls-v1.onnx to app/models, detect.js `ML_MODEL_URL` → walls-v1, `ML_SIZE` 640 → **512**
(v1's train size). Removed walls-v2.onnx from app/models. Net ML state = ORIGINAL
walls-v1 (512) + doors-v2 (640) + simple vectorizer. The entire retrain effort
(walls-v2, doors-v3/v4, clutter) ended up NOT beating the originals in real use — kept
for the record in roomwalk-ml but none shipped. **What DID stick = the app-side wins:**
heal logic (doors-as-truth, connect to nearest wall, no angles), opening free-move +
corner-clip (2D), detection debug overlay, manual opening fix-ups. models/ = walls-v1 +
doors-v2 only.

**OCR auto-scale from the plan (2026-06-18) — NEW FEATURE.** Reads the printed size off
a floor plan and scales everything to it. On-device, no backend: vendored **Tesseract.js
v5** under `vendor/tesseract/` (esm + worker + simd core + eng.traineddata.gz, ~10MB),
lazy-loaded like pdf.js/ort.
- Node spike validated OCR: raw full-image OCR is poor, but **4× upscale + sparse-text
  PSM 11** reads "405 sq ft" off 316 Gunson cleanly. Dimension marks (' ") often dropped
  → dimension path is best-effort (as predicted); area is the reliable primary.
- `ocr.js`: `readPlanText(img)` (upscale→canvas→recognize, word centres in orig px),
  `parseAreaFt2(text)` (sq ft / sf / ft² / m²→ft²), `parseDimensions(words)` (feet-inches
  needing a ' mark). Tesseract ESM exposes API via DEFAULT export; paths absolute `/vendor/tesseract/`.
- `app.js` `autoScaleFromPlan()` decision tree (matches user goal): PRIMARY printed area →
  `scale=sqrt(polygonAreaPx/sqft)`; FALLBACK dimension label matched to nearest wall →
  `wallPx/feet` (median); if both read and DISAGREE >15%, or neither reads → prompt for
  area. `openAreaModal` popup shows "Floor plan = X sq ft … applied" with an input
  pre-filled to the detected value — **user input always overrides** (their source of truth).
  Requires traced/detected walls (needs the closed polygon). UI: Advanced → Scale →
  "✨ Auto-scale from plan". Wired action `auto-scale`. All parses; vendored files serve 200.
  UNTESTED in browser (Tesseract worker load from vendored paths is the risk) — user to test.

**OCR diagnosis — "detects Gunson but not other plans" (2026-06-18):** dumped OCR text on
all example plans. NOT a bug: only 316 Gunson ("405 sq ft") and 609 GR ("626 sq ft") PRINT
a total area; 513 Hillcrest / 920 Ann / Chalet / Lodges have room dims but NO sq ft label.
OCR correctly reads area on 100% of plans that print one. No-sqft plans → fall to
dimensions, then the manual area prompt (correct). **Real bug fixed:** fixed 4× upscale
made big plans huge (920 Ann → 10200px canvas, tab-crash risk). Now ADAPTIVE: long edge
→ ~2600px, clamped [1×,4×]. Verified Gunson 405 / 609 626 still read; 920 Ann no longer
blows up. Possible refinement: require multiple agreeing dimensions before auto-applying
the dimension fallback (one mangled dim could mis-scale; popup override mitigates).

**OCR auto-scale SCRAPPED (2026-06-18, user request).** Dimension fallback mis-scaled
920 Ann to 3314 sq ft (actual 850) — unreliable. Removed entirely: deleted `ocr.js` +
`vendor/tesseract/`, removed autoScaleFromPlan/dimensionScale/decideScale/openAreaModal +
the ocr import + projectPointToSegment import + the "✨ Auto-scale" button + `auto-scale`
action. Calibration is MANUAL again via the existing Advanced → "Set scale by dimension" /
"Set scale by square footage" (type the real area, e.g. 850). vendor/ = ort, pdfjs, three.

**DONE — walls mutable like doors (2D, view2d.js):** drag a wall BODY to move the whole
wall; drag a wall ENDPOINT (corner) to reposition it — all walls sharing that corner move
together (joined corners stay joined). Snapping: a dragged corner / a moved wall's endpoint
snaps to another real-wall corner within SNAP_PX (corner-join), or the build grid in scratch
mode; else free. Selected wall shows red grab handles on its endpoints. Bridges (door
carriers) excluded — edited via the door tools. New helpers: hitTestWallEndpoint,
wallEndpointCluster, nearestWallEndpoint; drag kinds wall-move / wall-endpoint; handles in
draw(). Attached openings/rooms follow their walls automatically.

**Refined — walls stay strictly H/V, resize not reposition (user: "shouldn't be that
free… only V or H… mainly for resizing"):**
- BODY drag → moves the wall PERPENDICULAR to itself only (horizontal wall = up/down,
  vertical = left/right); the perpendicular walls at its ends STRETCH to follow (their near
  end slides along their own axis, far end fixed) → clean room-resize, no diagonals, joints
  stay joined, no cascade. Captures conn1/conn2 neighbour endpoints at grab.
- ENDPOINT drag → corner stays axis-locked: snap to another corner / grid, else lock to the
  dominant drag axis; each wall at the corner is re-straightened to stay H/V (far-end perp
  coord follows). Drag along a wall = resize length; drag across = shift it.
Geometry note: a wall can only move perpendicular (endpoints slide along connected
perpendicular walls' axes) — that's why everything stays rectilinear. No free 2D translate.

**Refined again — endpoint drag = move JUST one point (user: "move just a point, not the
entire wall"):** dropped the corner-cluster/follow on endpoint drag. Now grabbing a wall
endpoint moves ONLY that wall's one endpoint, axis-locked (stays on the H or V axis from
the fixed far end, whichever the cursor is nearer) so the wall never goes diagonal. Snaps
to another corner if it lands on one (re-join). hitTestWallEndpoint returns {w,k}. Body
drag (perpendicular move + neighbour stretch) unchanged. wallEndpointCluster still used by
body-drag for conn neighbours.

**Wall/door/window tools are 2D-only (user req):** app.js `syncToolsToView(v)` (called from
switchView + on init) hides the wall/door/window tool buttons in 3D/Walk and falls back to
Pan if one was active; their W/D/R keyboard shortcuts are gated to `state.view === '2d'`.
Pan + Items (furniture) stay available in all views (furniture placement works in 3D).

**How-to guide rewritten (index.html, 9 → 5 steps) to match the new flow:** 1 Start (2D
upload / scratch), 2 Detect & fix (doors/windows FIRST then walls; beta caveat; drag
endpoints/wall-body/openings to fix in 2D; manual tools fallback), 3 Scale (sq ft or wall
dimension), 4 Furnish (2D/3D/Walk, rotate/delete, wall items, optional style), 5 View &
walk + autosave/Save. Fixes old guide's backwards detect order; reflects 2D-only tools +
wall/opening mutability.

**Earlier next:** with the loop in place, attack the worst failure mode observed —
candidates: floating doors/windows (bridge-healing + scale-aware attach tol),
closet/interior recall (short-stub drop), orientation from box aspect. Wall-side
debug (mask / pre-snap band centerlines) not yet drawn.

---

## 2026-06-17 — On-device ML detection + Advanced-menu simplification

**Shipped (uncommitted in the repo; spike/feature artifacts):**

- **On-device ML detection** (ONNX Runtime Web, WASM single-thread — no backend,
  works offline, stays a pure static app). Vendored under `vendor/ort/`; models
  in `models/`. Both lazy-load on first use (mirrors pdf.js) and are cache-
  immutable in `_headers`.
  - **Walls** (`detectWallsML`): U-Net segmenter → wall mask → reuses the existing
    `wallsFromMask` band/snap vectorizer. `models/walls-v1.onnx`. ~90% on examples.
  - **Doors/Windows** (`detectDoorsWindowsML`): YOLOv8n 2-class detector →
    boxes snapped to the nearest **same-orientation** wall and attached as
    openings (bridge fallback when no wall fits; drop if far from everything).
    `models/doors-v2.onnx`. ~85% on 316 Gunson; dense interior clusters need
    manual cleanup.
  - State: `setMLOpenings(items)` (attach-to-wall OR bridge; idempotent).
  - UI: **two independent, order-free** actions — "✨ Detect walls" and "✨ Detect
    doors & windows". **Recommended order is doors/windows FIRST, then walls.**
    - Door button **never touches walls**: opening snaps onto a matching-orientation
      wall if one exists (clean 3D hole), else placed where the model found it
      (bridge) — matches the `test_ml.html` spike. Works standalone.
    - Wall button uses `setDetectedWalls` (NOT `replaceWalls`): it **preserves
      existing doors/windows** and **re-homes** each onto the nearest matching new
      wall (so the real wall segments AROUND the opening — no wall drawn over the
      door), keeping a bridge only where no new wall lands. Fixes the bug where
      detecting walls wiped the openings and covered them.
    - Heuristic `detectWalls`/`detectOpenings` remain as internal fallback.

- **Advanced menu simplified:** Detect = two ML buttons (was 4). Scale = "by
  dimension" + "by square footage" (dropped "by selected wall"). **Removed** the
  Style section (floor/wall colour are set by selecting in 3D) and the outline
  toggle + outline-detail slider. Plan opacity is the only image control. The
  blueprint extraction (dark lines/text → graphite, white → transparent) is now
  always on (no toggle); reverted an experiment that showed raw/true-colour pixels.

- **Door/window detection cleanup (refinement pass):** diagnosed via
  `roomwalk-ml/diagnose_overlay.py` (overlays wall mask + d/w boxes on the example
  plans) — finding: the WALLS model is solid across styles; the mess is the d/w
  model over-firing (long wall double-lines / dimension lines read as "windows")
  plus swing-arc width inflation. Code-only fixes in `detect.js` (no retrain):
  per-class confidence (door ≥0.25, **window ≥0.40**); **drop oversized detections**
  (> ~8–9 ft OR > 35% of plan dimension — scale-free, `cleanWidthFt` + `DW_MAX_*`);
  **standardize single doors to ~3 ft** (also kills arc inflation); bridges sized to
  the cleaned width. 513 Hillcrest: 21 → 13 detections, fake long windows gone;
  316 Gunson unchanged. Knobs are constants at the top of `detect.js`.

- **Manual fix-up for openings (2D):** for fixing badly-generated/floating doors.
  Dragging the MIDDLE free-moves a floating (bridge) opening wherever you want — no
  auto-snap (the user explicitly rejected whole-door snap-to-nearest). Dragging an
  END (end-third handle) of a floating opening moves that end freely and **snaps it
  to the nearest wall ending (corner) within ~14px/zoom, or a wall line within
  ~12px**, reshaping the door to fill between its two ends. Openings already on a
  real wall slide/resize along it (unchanged). **On release, if a floating opening
  now lies ALONG a real wall (both ends within ~14px), it attaches to that wall** so
  the wall segments around it (fixes a window staying buried/"won't pop up" in 3D).
  Only fires when genuinely on the wall — not a snap-from-afar. Orphaned carrier
  bridges cleaned up on release. (`view2d.js` opening-move / opening-resize / mouseup.)

- **A wall can never hide an opening (3D):** `view3d` now cuts each wall for EVERY
  opening lying ALONG it (`openingsAlongWall`), not just its assigned `wallId` host
  — so a wall detected/placed/drawn over an existing door/window is still cut by it.
  Fixes a window clipped "out of existence" by a solid coincident wall taking
  precedence. Panes/jambs/pick-proxies still render once (with the host) — no dupes.

- **Straighter manual wall drawing:** the Wall tool now straightens the draft to
  H/V FIRST (`AXIS_SNAP_DEG` = 10°, was 6°) and snaps the end to an existing corner
  only when that corner lies on the straightened line. Previously `snapToEndpoint`
  fired first and yanked the wall crooked toward any nearby corner — bad now that ML
  detection litters the plan with wall endpoints. (`view2d.js currentDraftWallEnd`.)

- **Heal floating doorways (`state.healBridges`):** after `setDetectedWalls` places
  walls + keeps any floating opening bridges, a generated wall whose END is near a
  bridge endpoint AND nearly on that wall's own line (perp ≤ 8px, reach ≤ 34px along
  its axis) is extended to it — a **collinear** connection only, so it never cuts a
  diagonal across the corner (the first version dragged the outer wall diagonally to
  the door). Walls that would need a diagonal are left alone; missing orthogonal
  stubs (joints) the model didn't detect are drawn by hand. Connects flanking walls
  to the doorway and removes the stray ceiling sliver on the 316 Gunson closets.

- **Fluid manual wall placement on blueprints:** the 1-ft grid snap (`snapToGrid`)
  and the world-grid overlay (`drawWorldGrid`) are now **scratch-mode only** — they
  no-op whenever a blueprint image is loaded, so tracing is fluid (was grid-locking
  endpoints to the "blueprint squares"). Straighten-to-H/V (axis snap) still applies.

**ML training/refinement** lives OUTSIDE this repo at `C:\Users\arthu\roomwalk-ml\`
— see `roomwalk-ml/REFINING.md` for datasets (Roboflow `floor-plan-segmentation`,
CC BY), scripts, retrain/export steps, current metrics, and the refinement backlog.

**Known gap:** placement (snapping) is the lossy step, not detection. Dense
closet/bathroom clusters on short wall stubs are the weak spot. `DW_DEBUG` in
`detect.js` (false by default) logs each detection's attach/bridge/drop decision.

**Next if resumed:** refine per `roomwalk-ml/REFINING.md` (doorway-gap matching,
better interior-wall recall, our-own-style training data). Nothing committed since
`e6f0efa`; ML files + `vendor/ort` + `models/` are uncommitted.
