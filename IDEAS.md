# RoomWalk Ideas

A place for directions RoomWalk could grow into. Nothing here is committed work,
just thinking out loud so the ideas do not get lost.

## Mobile capture: walk the room, draw the plan in place

The big one. Today you rebuild a floor plan from an uploaded image or a blank
grid, sitting at a desk. This idea flips that around: stand in the actual room
with your phone and map it where you are.

You open RoomWalk on your phone, point the camera, and walk the perimeter. As you
go you mark each corner and trace each wall. The result is a to-scale floor plan
you can immediately furnish and walk through, with no tape measure and no printed
plan needed.

It feels LiDAR-style without needing a LiDAR sensor (most phones do not have one).
Instead it leans on what every phone has: the camera plus motion sensors for AR
tracking, with the person in the loop to confirm wall lengths and the layout.
That matches RoomWalk's existing philosophy of automatic where it can be, manual
where it counts.

### How capture could feel

**Option A, AR walk-and-tap (most automatic):**
- Stand in a corner, tap to drop the first point on the floor.
- Walk to the next corner. The phone tracks how far you moved, so the wall length
  comes from your actual steps.
- Tap the next corner. A wall is drawn between the two points, already to scale.
- Continue around the room and close the loop.
- Doors and windows: point at one and tap its two edges.

**Option B, point-along-the-wall (most manual, the fallback):**
- Stand at one end and aim the phone along the wall so a guide line runs down it.
- Tap to start, then either walk to the far end and tap, or just type the length
  if you measured it another way.
- Repeat for each wall, snapping new walls to existing corners.

Realistically it is a blend. AR gives a good first estimate of each wall, and you
nudge or type the exact length when you know it. Drawing the layout stays in your
hands, so a noisy sensor reading never locks in the wrong room shape.

### Why it fits what already exists

A lot of RoomWalk carries straight over:
- The data model is already walls, openings, and furniture in a shared coordinate
  space with a pixels-per-foot scale. Capture just produces the same walls and
  openings from a different input.
- The 3D and Walk views, per-room floors, styling, and the furniture catalog all
  run on that model, so a captured room is instantly viewable and furnishable.
- The "auto-detect plus manual fallback" pattern is already the house style here.

### Technical paths

- **WebXR as a PWA:** keep it a web app, add the camera and an AR session through
  WebXR, and let people install it to the home screen. This preserves the
  dependency-light, no-build spirit and means one codebase for desktop and phone.
  The main risks are browser AR support and tracking quality.
- **Native app (iOS ARKit, Android ARCore):** best tracking, plus access to real
  LiDAR on phones that have it. The cost is a separate codebase and app-store
  distribution. It could reuse the 3D and data concepts but not the literal code.
- **Hybrid:** capture in a thin native or WebXR shell, then hand the finished plan
  to the existing web viewer for furnishing and walking.

### Open questions

- **Scale and drift:** AR tracking drifts over a long walk, so the last corner may
  not meet the first. A "snap the closing corner back to the start" step plus a
  per-wall length confirmation would absorb most of that.
- **Phones with weak AR:** the point-along-wall plus typed-length flow has to work
  well on its own, not just as a degraded mode.
- **Multi-room:** capture one room, step through a doorway, capture the next, and
  stitch them along the shared wall.
- **Ceiling height:** default to a standard height and let the user adjust, rather
  than trying to measure it.

### Rough phases

1. Prove the data path: hand-enter walls on a phone-sized screen (no camera yet)
   and confirm the existing viewer feels good on mobile.
2. Add a WebXR session that drops floor points on tap and builds walls between
   them.
3. Add wall-length confirmation and loop closing.
4. Add doors, windows, and multi-room stitching.
5. Polish: on-screen guides, undo, and save to the same project format the desktop
   app already uses.

## Lightweight mobile version: draw-and-walk PWA (the achievable near-term)

The realistic, not-heavy version of all this, and the one to come back to first.
No ML, no camera, no AR, no backend. Just the existing app running well on a phone.

**Most of this already exists.** On desktop today you draw walls by tapping two
corners, "Start from scratch" gives a to-scale grid walls snap to, and the 3D
structure and walkthrough generate automatically. So "draw your room, it makes the
walls" is already the core flow. The only gap is making it work on a phone.

**The gap (small, well-scoped):**
1. **Touch input.** The app is currently tuned for a mouse (mobile was skipped in
   an earlier pass). Add finger drawing, pinch-to-zoom, and a layout that fits a
   phone screen. No new hard tech.
2. **Installable (PWA).** Add a `manifest.json` plus a service worker so it
   installs to the home screen and runs offline, like a native app, on the same
   single web codebase.

Estimated effort: days to a couple of weeks, not the AR mountain.

**Two flavours of "draw," both feasible:**
- **Tap the corners** (exists today): precise, snaps to the grid.
- **Freehand finger loop that straightens into walls:** a bit of extra logic to
  simplify the stroke and snap to right angles. Still modest.

**Suggested order when we pick this up:**
1. Make the existing draw-and-walk flow work properly with touch (finger draw,
   pinch-zoom, responsive layout).
2. Add the PWA install (manifest + service worker, offline-capable).
3. Optionally add freehand-straighten drawing on top.

## Whole-house mode: Apartment vs House at load

To support whole houses without piling complexity onto the common case (a single
floor apartment), the app gates multi-floor behind a mode choice at load.

### The mode picker

When the app first opens, the user picks one of two cards:

- **Apartment** loads the app exactly as it is today. Single floor, no level
  controls, no extra UI. Nothing changes for the people who only ever need this.
- **House** loads the same app plus multi-floor controls.

The mode is just a flag on the project (`mode: 'apartment' | 'house'`). It is set
at load and stored with the project so reopening keeps the same UX.

### House mode adds

- A **floor selector** in the top bar (Level 1, Level 2, Basement, etc.) and an
  **add floor** button.
- A **view layout** toggle for the 2D blueprint area:
  - **Single floor:** one floor occupies the full canvas, the other is hidden
    (or shown only as a faint underlay for alignment).
  - **Side by side:** two floors render in the canvas at once for visual
    comparison. Editing is locked to the currently selected one; the other one
    is visible-but-inactive (deselected).
- A **stair** primitive (see below) that connects two adjacent levels.

### Swapping back to Apartment

The user can switch a house project back to apartment by collapsing it: pick
which floor to keep, save, and the floor controls disappear. The result is the
exact current single-floor app, byte-for-byte. The discarded floors are dropped
on save so the project shape matches apartment exactly.

### Stairs (the only genuinely new primitive)

A staircase has to do three things:

1. **Render geometry** (treads + risers, or simpler proxies). Easy.
2. **Cut a hole in the floor above** so you can see and walk into it. The current
   per-room floor mesher assumes solid rectangles; this would mark a "no-floor
   rectangle" the mesher honors. Real, bounded refactor.
3. **Move the walk player between levels.** Two options: simulate stepping
   (each tread bumps eye height a few inches) or treat the stair footprint as a
   **ramp** that raises the player's y linearly as they walk along it. Ramp is
   much simpler and feels totally fine in practice.

Realistic first cut: a "Stair" item placed like furniture, fixed straight run
(no L or U shapes yet), with `level` (the lower floor it starts on) and a
direction. Drop it on level 0 and it auto-cuts a matching hole in level 1's
floor and behaves as a ramp in walk mode. L-shaped and U-shaped stairs are a
stretch goal once the straight run feels right.

### What about auto floor-splitting from one image?

Don't. Real multi-floor plans come as separate images per floor. The flow is:
upload one image per level, trace or auto-detect walls on that level, place the
stair so it lines up with the next level. Keeps the hard problem out of scope.

### The honest cost

Levels are not one feature in one place. They touch walls, openings, furniture,
detection, 2D rendering, 3D rendering, walk collision, per-room floors (now per
level), save/load, undo, and the new mode + floor selectors. None of those are
hard individually, but it's many small careful touches plus a stair primitive
that doesn't exist today.

## Startup / monetization direction

If RoomWalk ever became a product, the pillars would be: ML auto-detection of
doors and windows, auto-generated structure from a plan, whole-house support with
multiple floors, and the manual camera capture above.

**Feasibility:** all four are buildable today, none need a research breakthrough.
- ML door/window detection and structure generation is a known problem
  ("raster-to-vector floor plan parsing"), with public datasets (e.g.
  CubiCasa5K) and published models. This upgrades the current heuristic detector
  to a learned one.
- Multi-floor whole-house support is pure engineering (a "level" concept, stacked
  floors, aligned stairwells), no ML risk.
- Camera capture already exists in the market (Apple RoomPlan, Polycam, magicplan),
  so the capability is proven. The hard, differentiating part is doing it well
  without LiDAR.

**The real risk is competitive, not technical.** This is a crowded space with
strong incumbents (Apple RoomPlan is free; Matterport, Polycam, magicplan, and
CubiCasa for B2B). A generic "scan your house" app would fight uphill.

**Possible wedges (compete on a niche, not head-on):**
- **No-LiDAR capture.** The best scanners need a LiDAR iPhone/iPad Pro. Most
  Android phones and cheaper iPhones have none. "Works on any phone" is defensible.
- **Renter / student furniture-fit.** RoomWalk's origin use case: check whether
  your furniture fits before signing a lease. A real, underserved consumer pain
  point and a sharper story than a general room scanner.

**Architecture note.** RoomWalk today is a static, no-build web app. ML detection
means adding a backend for inference (or shipping an on-device model) plus MLOps.
That is a real shift from the current setup and should be planned for, not bolted
on later.

**Monetization sketch (rough):** freemium (free basic plan, paid for multi-floor,
high-res export, and AR capture); B2B for realtors, property managers, movers, and
insurance; or licensing the detection as an API.
