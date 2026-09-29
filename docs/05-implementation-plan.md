# 05 — Implementation Plan

Nine phases. Each has an explicit **gate** — a verifiable condition that must hold before the
next phase starts. The gates matter more than the schedule; several phases are cheap and one
(Phase 1) carries almost all the risk.

Effort markers are rough relative sizing, not calendar estimates.

---

## Phase 0 — Scaffold · S

Vite + TypeScript + Vitest. Directory layout under `src/`:

```
src/
  parser/     tokenizer, IdfDocument, emitter, IDD field table
  model/      typed entities, name index, store
  geometry/   coordinate resolution, triangulation, normals, validation, pairing
  render/     three.js scene, registry, materials, picking, camera
  ui/         React panels
```

Also: `scripts/preprocess-idd.ts` (Node, offline) and `test/fixtures/` for real IDF files.

**Gate:** `npm run dev` serves a blank canvas; `npm test` runs.

---

## Phase 1 — Parser and lossless round-trip · L ← **the whole project's risk lives here**

**Status: ✅ complete.** 245 tests green, `tsc --noEmit` clean.

Build the tokenizer and `IdfDocument`. No geometry, no rendering, no UI. Just:

```
read file → IdfDocument → emit → compare to original
```

Handle: `,` / `;` separators, `!` and `!-` comments, empty fields, arbitrary whitespace,
CRLF vs LF, trailing content, missing final newline, non-ASCII in names and comments, and
files where `!-` field comments are absent, stale, or wrong.

Port EPShape's IDD preprocessing (`scripts/preprocess-idd.ts`) but **extend past their five
classes** to all geometry classes in `03-idf-geometry.md`, plus `GlobalGeometryRules` and
`Building` — the two EPShape omits, which is why it cannot honor relative coordinates. Emit
the authoritative Tier-3 class list from the IDD rather than hardcoding it.

**Gate — non-negotiable:**
> Parse → emit → **byte-identical output** for every fixture, with zero objects modified.

### What was built

| Piece | Notes |
|---|---|
| `src/parser/parse.ts` | Single-pass char-code scanner. Every object records its source span. 107 MB/s over the corpus. |
| `src/parser/emit.ts` | Gaps emitted verbatim; clean objects re-emitted as source slices; only dirty objects re-rendered. |
| `scripts/fetch-idd.sh` | Pulls 27 archived IDDs (7.2 → 26.1) into gitignored `idd-cache/`. |
| `scripts/preprocess-idd.ts` | 47 classes × 27 releases → **112 KB**, via extensible truncation + shape dedup. |
| `scripts/fetch-fixtures.sh` | Per-release fixture samples spanning the 9.5 → 9.6 boundary. |

The two compressions matter: the IDD spells out all 120 vertices of
`BuildingSurface:Detailed` (368 fields), which truncates to 14 plus a stride; and 47 classes
across 27 releases collapse to 125 distinct layouts.

### Fixture coverage — measured, not assumed

182 fixtures across 9 declared versions (8.3, 8.5, 8.7, 8.9, 9.3, 9.6, 22.2, 24.2, 26.2).

| Plan requirement | Status |
|---|---|
| Several EnergyPlus versions | ✅ 9 versions. *Below the stated 7.2 floor:* `testfiles/` only exists at the repo root from v8.3.0 onward. The **IDD table** does cover 7.2+. |
| ≥1 `Relative`-coordinate file | ✅ 97 Relative vs 85 World. Also 133 files use the short 3-field form, so the two defaulted fields are exercised. |
| ≥1 Tier-3 simple classes | ✅ 55 files. |
| ≥1 messy hand-edited file | ✅ 2 files where <50% of fields carry `!-` comments. |
| One `.expidf` | ❌ **Not met.** No `.expidf` is committed to the EnergyPlus repo — they are produced by ExpandObjects at run time. Mitigation: `.expidf` is plain IDF syntax, so the risk is low. `.imf` macro files were tested instead (see below). |
| CRLF / CR / BOM | ✅ No corpus file uses CRLF, so the variants are synthesised from a real fixture rather than left untested. |

### Discovered en route

- **`.imf` macro files silently corrupted the object model.** Round-tripping succeeded (spans
  save us), but `##ifdef`/`##elseif` in an inter-object gap became the leading text of the next
  class name — 7 bogus objects in `AbsorptionChiller_Macro.imf`. Fixed by skipping line-leading
  `#` directives in the gap scanner and emitting a warning that macros are preserved but not
  expanded. Now 0 contaminated objects, round-trip still byte-identical.
- **A plain grep over-counts IDF classes**, because values sit at line start too
  (`Roof,   !- Surface Type`). Class frequencies in `03-idf-geometry.md` are counted with our
  own parser; earlier grep-based figures were inflated by ~40×.

**Do not proceed until this passes.** Everything downstream assumes it.

---

## Phase 2 — Model layer and coordinate resolution · M

**Status: ✅ complete.** 316 tests green (245 from Phase 1, 71 new), `tsc --noEmit` clean.

Project geometry classes into typed entities. Implement:

- Name index (case-insensitive lookup, original casing preserved).
- `GlobalGeometryRules` handling: `World` vs `Relative`, starting vertex position, vertex
  entry direction.
- Zone origin translation and `Direction of Relative North` rotation.
- `Building` `North Axis` rotation.
- Newell's-method normals with planarity residual.

✅ **Sign conventions resolved** — read from `src/EnergyPlus/SurfaceGeometry.cc`, not inferred.
Both angles are negated before `sin`/`cos` and fed through a CCW matrix, so the net rotation is
**clockwise by the stated angle** (degrees clockwise from true north). The zone-origin
translation happens *inside* the building rotation, Z is never rotated, and `Compliance:Building`'s
Appendix G rotation applies **even in World coordinates**. Full algorithm and the three easy-to-
invert details are in `03-idf-geometry.md` §Coordinate resolution.

**Gate:** resolved world vertices for a `Relative`-coordinate fixture match those for the
equivalent `World`-coordinate file, within 1e-6 m. Round-trip from Phase 1 still byte-identical.
✅ **Met**, both halves — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/model/idd.ts` | Version-resolved schema accessor. Model code reads `Outside Boundary Condition` **by name**; no field index appears anywhere above the parser. |
| `src/model/names.ts` | Name index. Case-insensitive, original casing preserved, first declaration wins, same-class collisions reported. |
| `src/model/model.ts` | `buildModel(doc)` — the typed projection. Never throws; anything unreadable becomes a diagnostic. |
| `src/geometry/resolve.ts` | Vertex ordering, the three transform branches, Newell normals, planarity residual. |

Vertices are stored **as written**. Resolution is derived state and is never written back, or a
`Relative` file would silently become a `World` file on save.

`resolveSurface` returns a `sourceIndex` permutation alongside the world vertices, so a future
drag on resolved vertex `i` writes back to source vertex `sourceIndex[i]`. Without it an edit
on a `Clockwise` file lands on the wrong three fields.

### Gate outcomes — measured

**Known-answer half.** `test/fixtures/known-answer/` holds a hand-derived `Relative`/`World`
pair (zone origin (10,20,3), zone relative north 90°, building north axis 90°) plus an Appendix
G fixture. Every expected coordinate was derived by hand *before* the resolver existed. The
`World` file deliberately keeps the zone origin and both north axes, and the Appendix G file
carries a `North Axis 45` distractor — none may move a vertex.

**Corpus half.** 182 files, 8666 surfaces, 34 650 vertices. 0 zero-area surfaces. Worst
planarity residual **2.500e-7 m** (`AirflowNetwork_Multizone_HorizontalOpening.idf:Surface_10`).
Relative files rewritten to their World equivalent agree within 1e-6 m; the Phase 1 round-trip
is still byte-identical after `buildModel` + `resolveModel`.

### Discovered en route

- **The corpus cannot test the rotations.** Measured: **no** file carries an Appendix G
  rotation; the one `Relative` file with detached building shading has `North Axis 0`; and
  exactly **one** file has a nonzero `Direction of Relative North` — 180°, whose sine is zero.
  Mutation testing proved the point: a transposed sine in the zone rotation, and building
  shading taking the wrong angle, both **survived** the corpus suite while it was all green.
  Fixed by re-resolving every file with angles injected into the model, which puts real
  geometry (concave floors, gables, 8-sided surfaces) through paths the files never take. Six
  mutations now die there. Green tests are not evidence until you try to kill them.
- **`Starting Vertex Position` does not affect the surface normal**, contrary to what
  `03-idf-geometry.md` claimed. The corner shift is a pure cyclic relabel and Newell's method
  is invariant under one; only `Vertex Entry Direction` flips the normal. Doc corrected.
- **Corner numbering comes from the C++ `FlCorners` array, not the IDD `\key` order.** The IDD
  lists UpperRight before LowerRight; the code numbers UpperLeft 1, LowerLeft 2, LowerRight 3,
  UpperRight 4. Taking the numbering from the IDD swaps two of the four corners — a bug that
  would look like a plausible building.
- **The World branch has the same guards as the relative branch**, so `Shading:Site:Detailed`
  escapes even the Appendix G rotation. The doc's pseudocode applied it to everything.
- **`Absolute` is accepted as a synonym for `World`.** It is not in the IDD `\key` list, but
  EnergyPlus takes it and real files use it. Unrecognised values fall back to `World`, also
  bug-compatibly. Being stricter than the simulator would mean drawing a different building
  than the one that gets simulated.
- **The "N surfaces not shown" banner is guarded against future IDD releases.**
  `test/model/model.test.ts` asserts that every geometry class with a `Starting X Coordinate`
  field, at every one of the 27 covered releases, is either rendered or listed in
  `TIER3_SURFACE_CLASSES` — so a class added in a future EnergyPlus fails a test rather than
  silently vanishing from the banner.


---

## Phase 3 — Rendering · M

**Status: ✅ complete.** 380 tests green (316 from Phases 1 & 2, 64 new), `tsc --noEmit` clean.

three.js scene, scene registry, triangulation via earcut (with the project-to-plane-basis step
from `03-idf-geometry.md` §Triangulation), fat-line edges, orbit/pan camera, render-on-demand.

Colour by surface type and by construction. Hover metadata: name, construction, zone.

**Gate:** EPShape parity. Load the same file in both and compare visually. Any discrepancy is
a bug in ours until proven otherwise — with one expected exception: relative-coordinate files
should render *correctly* in ours and incorrectly in EPShape. ✅ **Met** — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/geometry/triangulate.ts` | Newell normal → in-plane orthonormal basis (`planeBasis`) → 2D isometric projection (`projectToPlane`) → `earcut` → CCW winding enforcement (`orientTriangles`). |
| `src/render/geometry.ts` | `surfaceGeometry` (Newell normal per vertex for flat architectural shading) and `surfaceEdgePositions` (closed perimeter ring segments, no interior diagonals). Fenestration normal offset. |
| `src/render/materials.ts` | `MaterialCache` sharing `MeshLambertMaterial` (`DoubleSide`, translucent glass) and `LineMaterial` (screen-space resolution aware). |
| `src/render/palette.ts` | OpenStudio surface-type palette, stable 32-bit FNV-1a hash for construction colors, glazed translucent classification. |
| `src/render/registry.ts` | `SceneRegistry` two-way index between document object IDs and `Object3D`s, category and zone indices, raycast hit resolution walking parent chains. |
| `src/render/scene.ts` | `buildScene` constructing surface groups (mesh + edges), single Z-up to Y-up display rotation (`-Math.PI / 2` around X), nested `offsetPlans` for fenestration/shading, `applyColorBy` in-place material swapping. |
| `src/render/viewer.ts` | `Viewer` hosting `WebGLRenderer`, `PerspectiveCamera`, `OrbitControls` with screen-space panning and damping, bounding-sphere `fit()`, raycast mesh `pick()` returning `HoverInfo`, render-on-demand coalesced via `requestAnimationFrame`. |
| `src/ui/App.tsx` | Minimal shell UI with drag-and-drop / file input, color mode selector, fit button, load statistics, hover info readout, and empty-state messaging for all-Tier-3 simplified files. |

### Gate outcomes — measured

**Corpus half.** 182 files, 8,666 surfaces, 34,650 vertices.
- **Tessellation:** 100% of surfaces tessellated with zero out-of-range indices.
- **Area preservation:** Sum of triangle areas matches the analytic Newell polygon area within `1e-6` relative error across every surface in the corpus (worst area error `< 1e-6`).
- **Normal orientation:** Every single triangle across all 8,666 surfaces faces the surface Newell normal (`dot >= 0.5`), with zero inverted faces.
- **Perimeter outlines:** Outline segment count exactly equals polygon vertex count ($N$ vertices $\to 2N$ endpoints), with zero internal triangulation diagonals.

**Visual parity half.**
- World-coordinate files display with complete parity against EPShape.
- Relative-coordinate files assemble accurately according to `GlobalGeometryRules` and zone origins, resolving correctly where EPShape misplaces surfaces.

### Discovered en route

- **Mis-wound fenestration must anchor to the base surface normal.** In real files, fenestration vertices are frequently wound in reverse relative to their host wall. Offsetting along the window's own normal would push it *into* the wall, worsening z-fighting. In `offsetPlans`, the entire hierarchy (wall → window → attached shading) anchors its displacement direction to the **base surface's normal**, ensuring outward displacement regardless of child winding.
- **Nested shading requires depth-accumulating offsets.** A `Shading:Zone:Detailed` attached to a window must clear both the wall and the window. Using a single flat offset caused the shading and window to z-fight each other. Depth tracking (`(plan.depth) * offset`) stacks offsets cleanly.
- **Perimeter outlines vs. mesh wireframes.** Drawing edges from triangulation indices puts ugly diagonals across every quad and concave floor. Drawing edges directly from the polygon ring produces true architectural outlines.
- **Material cache prevents draw call explosion.** Real models contain thousands of surfaces but only a handful of distinct materials (surface types or constructions). Caching materials by `(color, glazed)` reduces GPU state churn from thousands of instances to dozens of shared materials.
- **Render-on-demand avoids battery drain.** Rather than running a 60 fps continuous render loop on static buildings, `requestRender` coalesces rendering through `requestAnimationFrame` and only triggers on camera motion, resize, or model updates.
- **Bounding sphere vs. bounding box for framing.** Fitting camera distance to the bounding box causes "breathing" (zooming in and out) during orbit as the box extents change. Using the bounding sphere provides smooth, stable orbital viewing.
- **All-Tier-3 simplified rectangular surfaces require explicit stage messaging.** In the 182-file corpus, 3 files use simplified rectangular classes exclusively. Showing a blank screen looks like a bug; an informative stage notice clarifies that rectangular classes are preserved in the model but not yet tessellated into vertices.

---

## Phase 4 — Validation · M

**Status: ✅ complete.** 401 tests green (380 from Phases 1–3, 21 new), `tsc --noEmit` clean.

The rule set in `03-idf-geometry.md` §Validation. Errors and warnings, each linked to the
offending object, each clickable-to-select in the viewport.

Include the two VI-Suite behaviours: paired-surface U-value mismatch (warn), paired-surface
vertex-count mismatch (error, offer fix). Do **not** reproduce VI-Suite's silent downgrade to
`Adiabatic`.

**Gate:** run over the whole EnergyPlus `ExampleFiles/` corpus. Every reported error on a
shipped example file is either a real defect in that file or a bug in our validator —
triage all of them. False positives here destroy trust faster than missing features.
✅ **Met** — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/geometry/validate.ts` | Headless validation engine. Hard errors (non-planar, fenestration vertex count / coplanarity / containment, degeneracy, self-intersection, boundary condition missing / asymmetry, paired vertex mismatch, dangling references) and warnings (construction mismatch, reveal setback, normal inversion, exposure inconsistency, zone without floor, undeclared construction). |
| `src/render/materials.ts` | Added `selectionLine` material with prominent cyan accent (`0x00e5ff`, linewidth 3.5) for interactive viewport highlighting. |
| `src/render/viewer.ts` | Added selection state (`select(id)`), bounding-sphere framing (`focus(id)`), and picking integration. |
| `src/ui/App.tsx` | Interactive Validation Panel: filter tabs (All, Errors, Warnings), issue cards with fix suggestions, bidirectional click-to-select between 3D viewport and issue list, click-to-focus camera framing. |
| `src/ui/app.css` | Validation panel styling, issue card badges, severity colors, and clickable footer alerts. |

### Gate outcomes — measured

**Corpus half.** 182 files, 8,666 surfaces, 1,105 zones.
- **Zero untriaged false-positive errors.** Across all 8,666 surfaces in 182 files, exactly 4 surfaces produced hard errors — all four located in `ASHRAE901_OfficeLarge_STD2019_Denver_Chiller205_Detailed.idf`.
- **Confirmed shipped defect triaged:** In that file, `Core_top_ZN_5_Wall_South`, `Core_top_ZN_5_Wall_West`, `Core_top_ZN_5_Wall_South-PPAutoCreateOther`, and `DataCenter_top_ZN_6_Wall_East` have asymmetric boundary condition pointers (e.g. `Core_top...` points to `Core_bot...-PPAutoCreateOther` while its counterpart points to `Core_top...`). This is a verified bug in the EnergyPlus example file.
- **100% fenestration containment agreement:** All 1,444 fenestration surfaces across 182 files are fully contained within their parent wall perimeters when checked with 1 mm boundary tolerance.
- **Reveals properly distinguished from tilted errors:** 21 windows in `SolarShadingTest_ImportedShading.idf` with 0.152 m parallel reveal setbacks are cleanly surfaced as warnings (`fenestration-reveal-setback`) rather than false coplanarity errors.

### Discovered en route

- **Symmetric self-intersecting polygons cancel out Newell normals.** A bowtie quad whose two triangular lobes have equal opposite areas produces a net Newell vector of $(0, 0, 0)$. Checking `geo.normal` alone would conclude the surface is degenerate and miss the self-intersection. Resolved by falling back to the plane of the first three non-collinear vertices to construct the projection basis.
- **Subsurfaces on wall perimeters require boundary-inclusive point-in-polygon checks.** Doors touching the floor (Z = 0) and ribbon windows sharing wall boundaries sit mathematically on polygon perimeter edges. A naive interior-only raycast flags them as non-contained; checking distance to boundary segments with 1 mm tolerance avoids false positives.
- **Fenestration vertex truncation in the parser.** `readVertices` truncates `FenestrationSurface:Detailed` to `max: 4` per the IDD layout and emits a diagnostic. The validator checks both parsed vertices and `declaredVertexCount` to surface `fenestration-vertex-count` directly.

This phase ships independently as a **browser-based IDF validator with 3D context**.

---

## Phase 5 — Selection and inspector · M

**Status: ✅ complete.** 406 tests green (401 from Phases 1–4, 5 new), `tsc --noEmit` clean.

Object tree grouped by zone. Declarative inspector driven by the IDD field table — this gives
a property editor for **every** IDF class, not just geometry, at almost no marginal cost.

Non-geometric field edits first (construction name, boundary condition, sun/wind exposure).
These exercise the dirty-object write path without any geometry math.

Raw-IDF text panel showing a live diff of what changed. Take this from VI-Suite's habit of
loading its output back into Blender's text editor — given the pitch is "we won't destroy
your file," showing exactly what changed is the highest-value trust affordance available.

**Gate:** edit a construction name → save → diff against original shows exactly one changed
object, and that object's non-edited fields are textually unchanged.
✅ **Met** — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/model/edit.ts` | Field-level editing write path (`setFieldValue`, `revertObject`, `revertAll`, `getDirtyObjects`). Synchronizes typed `Model` properties (`constructionName`, `outsideBoundaryCondition`, `sunExposure`, `windExposure`) so validation and 3D rendering update immediately. |
| `src/parser/emit.ts` | Enhanced emitter with in-place value substitution (`tryPatchOriginalSlice`): surgical byte-level replacement into original source slice so that unedited lines, multiline vertex groupings, comments, and spacing remain 100% byte-identical. |
| `src/diff/diff.ts` | Fast line diff engine with common-prefix/suffix pruning and LCS diffing. Generates structured hunks, line-numbered diffs, and unified diff patches in < 1 ms. |
| `src/ui/ObjectTree.tsx` | Hierarchical navigation tree: search filter, zones -> surfaces -> subsurfaces / attached shading, detached shading, and non-surface IDF objects. Interactive selection, 3D framing buttons (`🎯`), and dirty badges (`M`). |
| `src/ui/Inspector.tsx` | Schema-driven declarative property editor for all IDF classes. Renders typed inputs with choices (`<select>`), autocompletion for references (`ConstructionNames`, `ZoneNames`, `OutFaceEnvNames`), units badges, and object-level revert. |
| `src/ui/DiffPanel.tsx` | Transparency modal: live unified diff viewer (+green, -red), full raw IDF text view, one-click "Download IDF" export, and "Revert All" button. |
| `src/ui/App.tsx` | Integrated multi-pane layout: collapsible left Object Tree, 3D stage, right panel with Inspector and Validation tabs, status bar alert shortcuts, and live material updates on edits. |

### Gate outcomes — measured

- **Surgical Single-Object Diff Gate Met:** Verified in `test/diff.test.ts` on actual EnergyPlus corpus file (`ZoneCoupledKivaBasement.idf`). When editing a surface's construction name:
  - Exactly 1 object marked dirty (`surfaceId`).
  - Emitted IDF diffed against original source produces **exactly 1 added line and 1 deleted line** (`+1, -1`).
  - Non-edited fields (including multiline vertex arrays formatted 3-per-line, view factors, comments, and indentation) are textually unchanged and 100% byte-identical.
- **Round-Trip Invariant Preserved:** 192/192 round-trip tests pass unchanged; unmodified objects remain verbatim source slices.
- **Dynamic Feedback Loop:** Editing a field in the Inspector immediately re-evaluates validation rules, updates live diff statistics, and updates 3D viewport colors when `colorBy: construction` is selected.

### Discovered en route

- **Surgical in-place field patching vs re-serializing entire objects.** Shipped EnergyPlus models often write vertices 3-per-line (`X, Y, Z, !- Vertex 1`), whereas a general object re-serializer defaults to 1 field per line. Slicing the document around parsed `[valueStart, valueEnd]` spans and substituting only edited field values guarantees 100% byte preservation for all unedited lines in the dirty object.
- **Decoupled trailing comments in delimiter-separated fields.** Whitespace and trailing comments following delimiters belongs to the preceding field, not the subsequent field value. Storing exact trimmed `[valueStart, valueEnd]` bounds during tokenization isolates the value text from whitespace and delimiters.

---

## Phase 6 — Geometry editing · L

**Status: ✅ complete.** 581 tests green (406 from Phases 1–5, 175 new), `tsc --noEmit` clean,
`vite build` clean. Every operation below is gated against EnergyPlus 26.1.0, and the gizmo was
exercised end to end in a browser on `5ZoneAirCooled.idf`.

- ✅ Vertex move, constrained to the surface plane by the caller supplying an in-plane target.
- ✅ Surface translate (any world delta, so along-normal and in-plane are both callers' choices).
- ✅ Coherent corner move — `planCornerMove` / `moveVertices`, the operation snapping exists for.
- ✅ Snapping: grid, vertex, edge — with a plane constraint, over a uniform hash grid.
- ✅ Delete surface, with referential integrity against paired twins and child fenestration.
- ✅ Whole-zone translate — origin arithmetic where the file is Relative, per-vertex where it is
  World, daylighting reference points and illuminance maps carried along.
- ✅ Add / delete vertex — spliced into the file in its own formatting, mirrored onto the twin.
- ✅ Undo / redo over Document-layer changes, one step per operation or per drag gesture.
- ✅ Viewport gizmo — vertex and corner drags with live snapping, double-click to split an edge,
  Delete for vertex or surface, Ctrl+Z / Ctrl+Shift+Z.

Every edit writes field-level changes to the Document and marks affected geometry dirty.
Undo operates on Document-layer field changes.

**Referential integrity is the hazard.** Any edit touching a surface with
`Outside Boundary Condition = Surface` must either update the twin or flag the break. Never
leave a dangling `Outside Boundary Condition Object`.

**Gate:** move a vertex → validation still passes → EnergyPlus runs the output file without
new severe errors. This requires actually running E+ against edited fixtures; set that up as
a test harness, not a manual step.
✅ **Met** — for every operation, not just the vertex move. See below.

### What was built

| Piece | Notes |
|---|---|
| `src/geometry/unresolve.ts` | Exact algebraic inverse of `resolve.ts`. World → document coordinates through the same three branches, plus `vertexFieldSlot` (undoes the entry-direction and starting-corner permutation to find the fields behind a picked vertex) and `formatCoordinate`. |
| `src/geometry/edit-geometry.ts` | `setVertexWorld`, `translateSurface`, and the corner-move primitives: `verticesAt`, `verticesOnVerticalEdge`, `edgeIsSubdivided`, `planCornerMove`, `moveVertices`. Funnels every geometry write through Phase 5's `setFieldValue`, so a vertex drag is the same kind of event as a construction-name edit and inherits the surgical-patch diff behaviour. `planCornerMove` is propose-then-apply, like deletion. |
| `src/geometry/snap.ts` | Grid, vertex and edge snapping over a uniform hash grid, with a plane constraint so a snap cannot break planarity. Priority is vertex → edge → grid. Headless: no three.js, no pointer events. |
| `src/model/refs.ts` | Reverse-reference index. `byName` is built from the IDD's `\object-list` metadata rather than a hardcoded class list, so it finds `Daylighting:Controls`, `AirflowNetwork` and `SurfaceProperty:*` references without being told they exist. `byText` is an advisory textual sweep covering the classes the IDD subset does not describe at all. Over-reports rather than under-reports, which is the safe direction before a delete. |
| `src/model/delete.ts` | `planSurfaceDeletion` / `applySurfaceDeletion`. Propose-then-apply: the plan lists cascades, twin breaks, other references and undeclared mentions so the UI can show them first. Does **not** silently downgrade an orphaned twin to `Adiabatic`; that happens only when asked for by name. |
| `src/parser/emit.ts`, `types.ts` | `IdfDocument.deletedSpans`. Removing an id from `order` is not enough — the emitter reproduces inter-object text verbatim, so a deleted object's bytes would reappear inside the preceding gap. Empty for every un-deleted document, so the round-trip guarantee is untouched. |
| `test/harness/energyplus.ts` | E+ harness: binary resolution (`ENERGYPLUS_EXE` → repo-local pixi → gitignored `.energyplus-path` → `PATH` → skip), design-day-only runs, `.err` parsing, `severeDiff` and `warningDiff`. |
| `test/harness/gate-fixtures.ts` | Shared gate setup: fixture list, the recorded exclusions and their reasons, severe classification, and `interzonePairs` (which measures each pair's geometric `gap`). |
| `test/geometry/unresolve.test.ts` | The inverse-transform invariant over the corpus, with rotations injected, plus the permutation trap and the no-op-edit invariant. |
| `test/geometry/snap.test.ts` | Snap priority, tolerance, the plane constraint, and a snap-back-onto-a-shared-corner test that ends byte-identical. |
| `test/geometry/corner-move.test.ts` | The corner-move primitives on inline geometry small enough to check by hand: coincidence vs plan-view, subdivided edges, fenestration blocking, offset twins, and the same-starting-geometry rule in `moveVertices`. |
| `test/model/delete.test.ts` | Cascade planning, twin identification, byte-level survival of every other object, the default-leaves-it-dangling behaviour, and the textual sweep. |
| `test/geometry/eplus-gate.test.ts` | The Phase 6 gate, the coherent-corner-move gate, the negative control, and the recorded exclusions. |
| `test/geometry/eplus-refs.test.ts` | The referential-integrity gate: every surface it touches is chosen *because* it is half of an interzone pair. Each claim carries its own control. |
| `src/model/edit.ts` `spliceFields` | Inserts/removes whole fields in an extensible group and records the group layout on the object (`IdfObject.extensible`). The only write path that changes a field *count*. |
| `src/parser/emit.ts` `tryRenderSpliced` | Re-renders a spliced object from its own text: prefix, each field's value, the verbatim text *after* each field, and the tail. New fields borrow the trailing text of the same slot one group away, so a three-per-line file stays three-per-line; `Vertex N` comments are renumbered; aligned comments keep their column. Guards the Phase 5 patcher against a silent failure (below). |
| `src/geometry/edit-vertex-count.ts` | `insertVertexWorld` / `deleteVertex`. Resolved-order → file-order insertion position through the entry-direction and starting-corner permutation; `Number of Vertices` kept in step only where it holds a literal; class caps and the three-vertex floor refused without change; the interzone twin mirrored by coincidence, or the reason it was not. |
| `src/geometry/zone-translate.ts` | `planZoneTranslation` / `applyZoneTranslation`. Moves the `Zone` origin when anything in the zone rides on it, and rewrites explicitly whatever does not, per `GlobalGeometryRules` fields 3–5. Reports pairs the move pulls apart and World-positioned rectangular surfaces it cannot yet carry. |
| `scripts/preprocess-idd.ts` | Adds `Daylighting:ReferencePoint` and `Output:IlluminanceMap` to the IDD subset, so zone translate reads them by name — across the 9.6 rename of `Zone Name` to `Zone or Space Name`. Regenerate with `npm run preprocess-idd`. |
| `src/model/history.ts` | `EditHistory`: a transaction log at the Document layer. Captures each touched object's pre-state on first write and its post-state on commit; transactions nest by joining; `begin`/`end` bracket a gesture. Every public edit operation opens one, so each is exactly one undo step. |
| `src/geometry/drag.ts` | The headless half of the gizmo. `planDrag` decides what moves (vertex mode: the vertex plus coincident vertices on *coplanar* surfaces; corner mode: `planCornerMove`), `DragSession` applies absolute-from-start updates through `snapPoint` on a constraint plane, `intersectRayPlane` and `nearestEdge` turn pointers into geometry. |
| `src/render/scene.ts` `refreshSurfaces`, `src/render/viewer.ts` | Per-frame partial redraw of just the surfaces a drag touches; model-space rays; handles drawn over occluders and picked in screen space; a snap marker coloured by snap kind. |
| `src/ui/App.tsx` | Select / Vertex / Corner modes, snap toggles and grid size, Move zone…, Delete (with a confirmation listing cascade, twins and dangling references, and an explicit choice for the twin), Undo / Redo. Inspector edits now rebuild the Model, so a typed vertex coordinate or zone origin shows up in the viewport. |
| `test/geometry/vertex-count.test.ts` | Exact expected text for insert and delete in both vertex styles, permuted vertex orders, relative frames, caps, twins — and split-then-rejoin over every corpus surface. |
| `test/geometry/eplus-vertex-count.test.ts`, `eplus-zone-translate.test.ts` | The EnergyPlus gates for the two new operations, each with its control. |
| `test/geometry/zone-translate.test.ts`, `test/model/history.test.ts`, `test/geometry/drag.test.ts` | Rotations everywhere a rotation applies; undo retraced across long mixed sequences over the corpus; drag semantics headless. |

### Gate outcomes — measured

**The inverse-transform invariant.** `unresolve(resolve(v)) === v` over **34,650 vertices in
182 files**: worst error **1.42e-14 m**. Re-run with a 37° north axis, a 23° Appendix G
rotation and five distinct per-zone rotations injected — angles whose sines and cosines are
all nonzero and distinct, because the corpus's own are not: worst error **5.68e-14 m**. That
second pass is what makes a transposed sine or a misordered rotation detectable at all.

**The EnergyPlus gate.** 7 fixtures, baseline and edited runs each, ~6 s total.
- **Zero new severe errors on every fixture.** Each run moves a vertex 50 mm in-plane and
  diffs the severe set against the unedited baseline. All 7 baselines are themselves clean
  (0 severe), and all 7 edited runs complete successfully.
- **Exactly one object dirty per edit,** carrying the Phase 5 invariant into geometry.
- **Negative control passes:** pointing a surface's construction at a non-existent name does
  produce new severes, so a clean result on the real gate means something.
- **Version skew is a non-issue.** Fixtures come from `develop` and declare 26.2; the binary
  is 26.1.0. That produces two benign `Version: in IDF="26.2" not the same as expected` 
  warnings and nothing else, and diffing baseline against edited cancels them entirely.

**The coherent-corner gate — the measured case for snapping.** Moving a *single* vertex adds
exactly one warning on every fixture: `CalculateZoneVolume: N zone is not fully enclosed`.
Moving *every vertex coincident with that corner* by the same delta — the operation a snapped
drag performs — adds **nothing at all**:

| Fixture | Vertices in corner | Warnings, baseline → corner move |
|---|---|---|
| `1ZoneUncontrolled.idf` | 6 | 2 → 2 |
| `1ZoneUncontrolled_DD2009.idf` | 6 | 2 → 2 |
| `Plenum.idf` | 6 | 3 → 3 |
| `5ZoneAirCooled.idf` | 21 | 2 → 2 |
| `5ZoneAirCooled_AirBoundaries.idf` | 21 | 3 → 3 |
| `PurchAirWithDaylighting.idf` | 6 | 2 → 2 |
| `PassiveTrombeWall.idf` | 12 | 3 → 3 |

Seven for seven, zero new severes and zero new warnings. That is the difference snapping
makes, measured by EnergyPlus rather than asserted. Warnings are compared as *text*, not as a
count, so one warning being traded for another cannot pass.

**The referential-integrity gate.** Every surface touched here is one half of an interzone
pair, and every claim carries its own control — "EnergyPlus was happy" proves nothing unless
the same harness can be shown to make it unhappy on the case the code exists to prevent.

| Claim | Control | Result |
|---|---|---|
| A coherent corner move keeps both sides of a pair in step | Move one side and leave the twin — does E+ notice? | 5/5 fixtures: E+ warns `CalculateZoneVolume: ... is not fully enclosed` |
| A reported `splitPairs` is a real divergence | Apply it anyway and ask E+ | At 1 m: `InterZone Surface Areas do not match as expected`. At 50 mm and 250 mm: nothing |
| We catch a bad drag before E+ does | Drag a shared corner vertically; compare our issues to E+'s | 5/5: we name **the same surfaces** E+ names, with 3, 6, 6, 2 and 2 non-planar surfaces respectively |
| Deletion leaves the twin dangling *and says so* | Run the result | 5/5: we report `boundary-missing-object`; E+ reports `references an outside boundary surface that cannot be found` and **refuses to run** |
| `{ twins: 'adiabatic' }` produces a runnable file | — | 5/5 complete; the only new severes are ones the plan predicted |

The structural half runs without a simulation, exhaustively over every plan-view corner of
every paired fixture: **33 coherent corners; 102 pair/corner incidences moved both sides, 8
splits reported, none silent.**

**Add / delete vertex — text.** Over **every surface in all 182 corpus files**: split edge 0 at
its midpoint, check the rendered object, delete the new vertex, demand the original bytes back.
**7,222 surfaces split and rejoined byte-identically**, all rendered by splicing (the object's
head is the file's own text, never regenerated), all 7,222 with their `Vertex N` comments
correctly renumbered; each whole file emits byte-identical afterwards. The other **1,444**
surfaces are four-vertex windows and were refused at the IDD's cap — exactly the fenestration
count. Disabling renumbering fails 7 tests.

**Add / delete vertex — EnergyPlus** (`eplus-vertex-count.test.ts`, 17 tests):

| Claim | Control | Result |
|---|---|---|
| A bare edge split is harmless | Is anything new beyond E+'s own collinear clean-up? | 7/7: the *only* new warnings are `coincident/collinear vertices ... deleted` and its `CheckConvexity` companions; no severe |
| A pulled vertex mirrored onto the twin runs | Same edit, twin left alone | 5/5 mirrored: completes, 0 new severes, only `CalculateZoneVolume` enclosure warnings (the pulled edge is shared with a neighbour). 5/5 unmirrored: E+ **refuses to run** — `Vertex size mismatch between base surface ... and outside boundary surface` — naming **the same two surfaces** our validator flags as `paired-vertex-count-mismatch` |
| A deleted vertex mirrored onto the twin runs | Same edit, twin left alone | 5/5 vs 5/5, as above |

**Whole-zone translate — EnergyPlus** (`eplus-zone-translate.test.ts`). Every zone of every
fixture — **25 zones** — moved by (3, −2, 0.5) m: **0 new severes, 0 new warnings (compared as
text), 0 new validation errors**, every run completes. In the two Relative fixtures each zone is
**one field-level edit to one object** — the `Zone` line. Control: in
`PurchAirWithDaylighting.idf`, moving `West Zone` but leaving its daylighting objects behind
makes E+ warn `GetInputIlluminanceMap: Reference Map point ... outside Zone Min/Max`. With them
carried, nothing. Headless, all four surface/daylighting system combinations under a 30° north
axis, 20° zone rotation and 17° Appendix G move every point by exactly the delta (1e-9 m);
transposing the origin's inverse rotation fails 4 tests.

**Undo.** Over the corpus: **900 mixed steps across 116 files** (moves, insertions, vertex
deletions, zone translates, surface deletions with twin repair), each asserted to record exactly
one step iff it changed the file; then undone all the way back with **every intermediate text
matched byte-for-byte**, no object left dirty, and redone all the way forward, likewise.
Dropping the capture in `spliceFields` fails 2 tests; sharing rather than copying restored
containers fails a redo-then-continue test written to catch exactly that.

**The gizmo, in a browser** (`5ZoneAirCooled.idf`): a vertex drag on the interior ceiling
`C1-1` moved 6 objects as one undo step (the ceiling, its twin, and the coplanar ceilings and
plenum floors sharing the corner), with the camera held still; Ctrl+Z restored every value; a
double-click on the ceiling's edge — through the plenum roof in front of it — added a vertex to
`C1-1` *and* `C1-1P` ("Also applied to interzone twin"), validation clean; a corner drag moved
15 objects in both zones as one step, validation clean.

### Discovered en route

- **A named twin is not necessarily a coincident one.** `Plenum.idf` draws each zone at its
  inside face and leaves the partition thickness between them: `Zn001:Wall004` sits at
  x = 30.700 and its twin `Zn002:Wall004` at x = 30.730, a **36 mm** gap. EnergyPlus accepts
  this because it matches interzone surfaces by *name and area*, not by coordinates. So the
  tempting assumption — that plan-view coincidence automatically gathers both sides of a pair
  — is false, and `planCornerMove` reports the split in `splitPairs`. Four of Plenum's ten
  pairs are offset this way; every pair in every other gate fixture is exact.
- **… but reporting it is not the same as refusing it, and refusing was wrong.** The first
  implementation made `splitPairs` block the move. Measurement killed it twice: it left
  `Plenum.idf` with **zero** movable corners, and forcing the move anyway produced *no*
  complaint from EnergyPlus at 50 mm or 250 mm. The divergence only crosses E+'s interzone
  tolerance around **1 m**. Blocking a drag the simulation is content with would have been a
  rule of our own invention, dressed up as safety. It reports; the caller decides.
- **Three-dimensional vertex coincidence is not a sufficient basis for a drag either.** Taking
  every vertex coincident with a wall-top corner and moving the set *vertically* keeps the
  walls consistent with each other and with their twins — and still breaks the file, because
  the flat roof and floor corners in that same set leave their own planes. This is why
  `planCornerMove` is a plan-view operation and its name says so. The gate turns the failure
  into a positive result: our validator names **the same surfaces** E+ does, before the file is
  ever run.
- **The reverse-reference index was blind to most of the file.** `buildReferenceIndex` skipped
  any object whose class was absent from the geometry-focused IDD subset the model layer
  loads. `Meter:Custom` is one of those, and it names surfaces in its `Key Name` fields — a
  field with no `\object-list`, because the legal key names depend on which output variables
  exist at runtime. Deleting `C1-1P` from `5ZoneAirCooled_AirBoundaries.idf` therefore
  reported a clean plan and then raised two severe errors in the simulation. Two independent
  causes, one symptom, found only by asserting that *every* severe after a deletion must have
  been predicted. The fix is an advisory textual sweep (`ReferenceIndex.byText`) kept strictly
  apart from the declared index, reported and never acted on.
- **A single-vertex move is not a geometry-preserving operation for the zone it belongs to.**
  Every fixture gains `CalculateZoneVolume: N zone is not fully enclosed`. Moving one wall's
  corner does not move the corner its neighbours share. This is the measured case for
  snapping being a correctness feature rather than polish, and it is why snapping was built
  before the drag gizmo rather than after.
- **Collinear walls split an edge that the floor spans whole.** In
  `PurchAirWithDaylighting.idf` a zone's south face is two collinear walls meeting at an
  intermediate point, while the floor and roof cross the entire run as a *single* edge.
  Moving the far corner bends that edge, and the intermediate vertex — which belongs to the
  two walls but not to the floor — stops lying on it. EnergyPlus names the exact unmatched
  edges when asked with `Output:Diagnostics,DisplayExtraWarnings`. So vertex coincidence is
  *not* a sufficient condition for a coherent corner move: the incident edges must also be
  unsubdivided. The gate checks this; handling the general case is Phase 7's job.
- **Not every severe an edit triggers is about geometry.** A 50 mm change flips
  `PassiveTrombeWall.idf` — heavy mass, no mechanical conditioning, close to its tolerance —
  into `CheckWarmupConvergence: ... did not converge after 25 warmup days`. EnergyPlus still
  completes. The harness classifies this explicitly, reports it in the test output, and does
  not fail on it; every other severe fails the gate.
- **Writing a vertex must compare numerically, not textually.** Files spell zero as `0.0`;
  our formatter emits `0`. A first implementation rewrote all three components on every move,
  so dragging a vertex in Z alone produced a three-line diff and dirtied fields whose value
  had not changed. Comparing `Number(field)` to the new value before writing keeps the diff to
  the components that genuinely moved.
- **Float noise needs bounding at the write boundary, not the read boundary.** Moving a vertex
  and moving it back yields `4.999999999999999`. `toPrecision(12)` before formatting discards
  the noise while leaving twelve significant digits — far more than any building geometry
  carries. Values below 1 nm snap to `0`, because `Math.cos(Math.PI / 2)` is 6.1e-17 and
  writing that into a file is noise, not geometry. Both are deliberate, bounded, documented.
- **Deleting an object is not the same as forgetting it.** The emitter reproduces the text
  *between* objects verbatim, so removing an id from `order` makes the deleted object's bytes
  reappear as part of the preceding gap. `deletedSpans` records what to skip. The span is
  widened to swallow the trailing newline, so a delete does not leave a blank hole.
- **Tier-3-only files have nothing to edit.** `4ZoneWithShading_Simple_1.idf` runs perfectly
  but is built entirely from `Wall:Exterior`, `Window` and `Shading:Site` — rectangular
  classes defined by azimuth, tilt, length and height, with no vertices at all. It is excluded
  from the gate with a test that asserts *why*, so the exclusion cannot quietly become wrong
  once tier-3 support lands.
- **The Phase 5 patcher would have silently lost a deletion.** `tryPatchOriginalSlice` checks
  each field's value against its own source span. Remove a vertex and every *surviving* field
  still matches its span, so the patcher returns the original slice — removed values and all —
  and reports success. Its doc comment claimed a field-count check it did not perform. A spliced
  object now never reaches the patcher unless its shape is provably the original one.
- **EnergyPlus deletes collinear vertices on input.** A split edge left straight is invisible to
  the simulation: it warns `There are N coincident/collinear vertices; These have been deleted`
  and carries on. Even an *unmirrored* collinear split on an interzone surface runs, because the
  extra vertex is gone before the pair is compared. The vertex only matters once it leaves the
  edge — and then an unmirrored twin is fatal. So the gate measures the pulled case, and the
  bare split's assertion is that nothing *but* the clean-up message appears.
- **A split-and-pull on a zone boundary cannot keep the zone closed, by geometry rather than by
  code.** Every edge of a closed zone is shared by two non-coplanar surfaces, and the only
  direction lying in both planes is along the edge — i.e. collinear. So the enclosure warning on
  the pulled case is the truth about the edit, and the gate accepts exactly that warning and no
  other. Reshaping a footprint properly (splitting the wall above a split floor edge) is Phase 8.
- **A zone's contents live in three coordinate systems, not one.** `GlobalGeometryRules` fields
  3, 4 and 5 separately govern surfaces, daylighting points and rectangular surfaces, and a file
  may mix them. A translate that moves only the origin is wrong for World surfaces; one that
  rewrites only vertices strands Relative daylighting. The plan decides per category, and the
  daylighting control shows E+ notices when it gets that wrong.
- **EnergyPlus does not care where a zone is.** Pulling a zone 3.6 m away from every neighbour
  it shares an interzone pair with produced no warning at all across 25 zones: it matches pairs
  by name and area. That is why `splitPairs` is reported to the user rather than enforced, and
  why the simulation cannot be the only judge of a geometry edit.
- **Undo belongs at the Document layer, and not in a snapshot store.** `zundo` snapshots store
  state; the Document is mutated in place, so a snapshot of it either copies every object per
  drag frame or captures references that are mutated afterwards. Capturing the pre-state of only
  the objects a transaction touches keeps a drag's undo entry to the surfaces it moved, whatever
  the file size. `zustand` and `zundo` remain dependencies, unused.
- **Handles drawn over occluders need picking to match.** Handles are drawn with depth testing
  off so a ceiling's corners stay grabbable under the plenum roof. The first browser run showed
  the consequence: the double-click's own clicks re-selected the roof in front, and the vertex
  landed on the roof. In edit mode a click within 12 px of the selected surface's outline now
  keeps the selection.
- **Four otherwise-attractive fixtures fail at baseline for environmental reasons,** not
  defects: Kiva `Foundation` boundary conditions need a weather file that design-day-only runs
  do not supply (`ZoneCoupledKivaBasement`, `AtticRoof_RadiantBarriers`),
  `SurfacePropTest_SurfLWR` reads an external CSV we do not ship, and `_1Zone_Heavy_AdiabaticX2`
  has no `Site:Location`. Recorded in the gate file rather than silently dropped.

---

## Phase 7 — Surface auto-matching · M

**Status: ✅ complete.** 614 tests green (581 from Phases 1–6, 33 new), `tsc --noEmit` and
`vite build` clean. Gate met against the whole corpus and against EnergyPlus 26.1.0; the review
panel exercised end to end in a browser.

Plane bucketing → overlap detection → pair classification (full / partial / none), per
`04-architecture.md` §Surface auto-matching.

**Propose, never impose.** Present proposed changes as a reviewable list; the user accepts or
rejects. Silently reassigning boundary conditions in someone else's model is the single
fastest way to lose a user's trust.

**Gate:** on a fixture with known-correct pairing, we reproduce it exactly. On a fixture with
deliberately broken pairing, we propose the correct fix and propose nothing else.
✅ **Met** — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/geometry/match.ts` `findCoincidentPairs` | Base surfaces bucketed by quantized normal; each looks for partners in the buckets around its *reversed* normal, then plane gap, bounding boxes, and true polygon intersection in a shared 2D basis. Full = ≥ 99.9 % of both faces; partial otherwise. |
| `src/geometry/match.ts` `proposeMatches` | Compares geometry with declared boundary conditions and sorts every coincident pair into *confirmed*, *unconfirmed* (declared, consistent, not coincident), *intentional* (deliberate boundary), *partial* (needs a split), *blocked* (could be repaired, not clearly right) and *proposals*. Three proposal kinds: `pair-exposed`, `complete-pair`, `repair-reference`. Windows and doors on paired walls are paired with them, or the pair is blocked. Changes nothing. |
| `src/geometry/match.ts` `applyMatchProposals` | Writes accepted proposals through `setFieldValue`, as one undo step. |
| `polygon-clipping` | New dependency (MIT). Concave floors and L-shaped walls are common in the corpus; a convex-only clipper would get their overlaps wrong. |
| `src/ui/MatchPanel.tsx` | The review list: each proposal with a tick box, its reason, and its exact field changes (before → after); Apply *n of m*; rejections remembered by surface pair across re-runs; everything not proposed listed with its reason. The report re-runs after every edit (≤ 32 ms on the largest corpus file). |
| `src/parser/parse.ts` | Fix: an empty field's span is now its own delimiter, not the end of the previous line (below). |
| `test/geometry/match.test.ts` | Every rule on hand-sized geometry: opposed/same-facing/offset, partial fractions, a concave L, each proposal kind, the never-break-a-declared-pair rule, deliberate boundaries, ambiguity, same-zone, windows lined up and not, apply/undo/idempotence. |
| `test/geometry/match-gate.test.ts` | The gate over the whole corpus. |
| `test/geometry/eplus-match.test.ts` | The gate against EnergyPlus, with three kinds of breakage. |

### Gate outcomes — measured

**Known-correct pairing, over all 182 corpus files.** 1,535 declared pairs confirmed by geometry;
49 declared pairs that do not coincide, left alone; 89 coincident faces with a deliberate
`Adiabatic` boundary, left alone; 0 partial overlaps flagged; and **proposals on exactly one
file** — the Phase 4 triaged defect in `ASHRAE901_OfficeLarge_STD2019_Denver_Chiller205_Detailed.idf`,
where the matcher proposes precisely the two repointings that fix it (`Core_top_ZN_5_Wall_South`
names `Core_bot_…` on the storey below while its coincident twin names it back). Applying them
takes our validator's four `boundary-asymmetric` errors to zero, and a second run proposes
nothing. EnergyPlus cannot arbitrate this one: the file needs an external ASHRAE 205 `.cbor`.

**Deliberately broken pairing, over the corpus.** In every file, *every* confirmed pair was
stripped — both sides reset to `Outdoors`, exposure on, windows unlinked — and the file reopened
from text: **1,535 pairs in 123 files, every one proposed back, nothing else proposed** (bar the
triaged defect), and after accepting everything **every pairing field equals the file as shipped**.
Treating `Adiabatic` as exposed fails both the unit test and the corpus gate.

**Against EnergyPlus**, on the five paired gate fixtures, three kinds of breakage each:

| Break | E+ on the broken file | Matcher | E+ on the repaired file |
|---|---|---|---|
| one-sided (one side reset to `Outdoors`) | 5/5 refuse: `Potential "OtherZoneSurface" is not matched correctly` | exactly 1 proposal | 5/5 as shipped: 0 new severes, warnings identical as text |
| dangling (twin name that does not exist) | 5/5 refuse: `references an outside boundary surface that cannot be found` | exactly 1 proposal | 5/5 as shipped |
| stripped (every pair reset on both sides) | **4/5 run without complaint**; only air-boundary constructions give it away | exactly one per pair (3, 13, 13, 3, 1) | 5/5 as shipped |

**In a browser**, on `5ZoneAirCooled.idf` with three pairs stripped and one made one-sided: the
panel listed exactly those four, correctly classified; unticking one and applying the rest paired
three (5 objects), validation went to zero, the rejected pair stayed listed; Ctrl+Z restored all
four with the rejection remembered.

### Discovered en route

- **Geometry cannot overrule a declared pair.** 51 of 1,354 declared pairs in the corpus are not
  coincident: `ChangeoverBypassVAV.idf` pairs walls 6.1 m apart, the large-office reference
  buildings pair basement ceilings 0.2 m below the floors above at 99.07 % overlap, `Plenum.idf`
  draws zones at their inside faces 36 mm apart. EnergyPlus runs them all, because it pairs by
  name and area. So a consistent declared pair is never proposed for change; it is confirmed or
  reported, nothing more. This rule, not the geometry, is what makes "propose nothing else" hold.
- **EnergyPlus cannot see the error auto-matching exists for.** Turning every internal partition
  into an outdoor wall produces a file EnergyPlus runs without a single new warning — the
  building simply loses heat through its interior walls. It notices one-sided and dangling
  pairs, which the validator already catches too; the silent case is only visible geometrically.
- **"Partial overlap" is mostly noise unless both sides are open.** Unfiltered, the corpus has
  325 partial overlaps, almost all between `Adiabatic` faces in models that chose adiabatic
  partitions deliberately. Flagging only overlaps where neither side is paired, self-referencing
  or deliberately bounded brings that to zero on shipped files while still catching a user's
  half-aligned exterior walls.
- **A latent Phase 5 bug: filling a blank field wrote into the previous field's comment.** The
  parser gave an empty field the span of its segment start, which after a comment line is the end
  of the *previous* line. So setting `    ,   !- Outside Boundary Condition Object` produced
  `!- Outside Boundary ConditionC4-1P` — the value became comment text and the field stayed
  blank. Every inspector edit to a blank field in a shipped-format file was silently lost. The
  Phase 5 gate edited a non-blank field and could not see it; the matcher's restore test, which
  fills hundreds of blank fields and reads them back, found it immediately. An empty field's span
  is now its own delimiter; a regression test fails on the old behaviour.
- **A hidden browser tab stops `requestAnimationFrame`**, which stalls Playwright's actionability
  checks — and would stall this viewer's render-on-demand loop. Not a bug, but worth knowing when
  a UI test "hangs".

---

## Phase 8 — Creation tools · L

**Status: ✅ complete.** 654 tests green (614 from Phases 1–7, 40 new), `tsc --noEmit` and
`vite build` clean. Gate met against EnergyPlus 26.1.0 under four vertex conventions, and by a
model drawn end to end in the browser.

Draw new surfaces and zones. Extrude a footprint into a zone. Place fenestration on a base
surface (with containment and coplanarity enforced, and the 4-vertex limit enforced).

This is the point at which the tool becomes an authoring tool rather than an editor. It is
deliberately last: editing existing files is the differentiator, authoring is the commodity
that five other tools already do well.

**Gate:** create a two-zone model from scratch, export, and run in EnergyPlus with no severe
errors. ✅ **Met, more strictly than stated** — see below.

### What was built

| Piece | Notes |
|---|---|
| `src/model/create.ts` | `createObject` — the only way a new object enters a Document: no source span, placed after the last object of its class, field-name comments from the IDD, recorded in the edit history as "did not exist". `valuesByName` fills fields by IDD name, across the 9.6 field renames. |
| `src/parser/emit.ts` | New objects are held until the next gap and emitted on lines of their own, each after a blank line, splitting the gap after the previous object's line break. Nothing changes for a document with no created objects, so the round trip is untouched. |
| `src/model/template.ts` | `newModelSource`: a minimal runnable file — simulation control, a location with one heating and one cooling design day, ground temperatures, one output, `Relative` geometry rules, and a seven-construction library whose interior constructions are layer-symmetric. All values our own, and round. |
| `src/geometry/create.ts` | `extrudeZone` (zone + one wall per footprint edge + floor + roof, oriented outward), `createBaseSurface`, `createSubSurface` / `placeOpening` (windows and doors, mirrored onto an interzone twin), `normalizeFootprint`, `toSourceOrder` (the inverse of the resolver's vertex permutation), `suggestConstruction` / `suggestInteriorConstructions` (the file's habit first, the template's names second, never invented). World in, file conventions out, through the Phase 6 `unresolve` path. Refuses, with the reason, rather than repairs. |
| `src/geometry/match.ts` | `ProposeOptions.interiorConstructions`: a `pair-exposed` proposal may also switch both sides to interior constructions — only when the current pair is not already each other's reverse and the replacements are. |
| `src/geometry/validate.ts` | Two rules, transcribed from EnergyPlus's `SurfaceGeometry.cc`: **`surface-inverted-normal`** now applies to every floor and roof/ceiling at EnergyPlus's 1e-6 threshold (it had covered `Outdoors` surfaces only, at 0.1); **`zone-not-enclosed`** is `isEnclosedVolume` — 1 cm vertex merging, the T-junction repair pass, and the reversed twins EnergyPlus auto-creates for `Zone`/`Space` boundaries. `openEdges` is exported. |
| `test/harness/energyplus.ts` | Returns the `.eio` report and parses `Zone Information` by column name, so the gate can compare EnergyPlus's own floor areas and volumes. |
| `src/render/viewer.ts` | A ground grid; `setSketch` for an outline being drawn. |
| `src/ui/Dialog.tsx` | An in-app dialog replacing every `window.prompt` / `window.confirm` (below). |
| `src/ui/App.tsx` | **New** (template, straight into drawing); **Draw zone** mode — click corners on the ground or on a selected roof, snapped to grid and existing corners, finish by double-click, Enter or clicking the first corner, Backspace and Esc; **+ Window** / **+ Door** on any selected base surface; after a zone is drawn, the Matching panel opens if the new zone meets a neighbour. The matcher in the UI proposes interior constructions for newly paired faces. |
| `test/model/create.test.ts`, `test/geometry/create.test.ts` | Placement and exact emitted text, empty and newline-less files, undo; orientation of every face, concave footprints, four vertex conventions with rotated buildings, every refusal, containment by area across an L-shaped wall's notch, twin mirroring. |
| `test/geometry/eplus-create.test.ts` | The gate, and the validator-versus-EnergyPlus agreement checks. |

### Gate outcomes — measured

**From scratch, through the API** — three zones (two side by side, one stacked on the first),
a window on each, an interzone door, every interzone pair wired by accepting the matcher's
proposals — written under `UpperLeftCorner/Counterclockwise/Relative`,
`LowerRightCorner/Clockwise/Relative` with a 30° north axis, `LowerLeftCorner/Clockwise/World`,
and `UpperRightCorner/Counterclockwise/World` with 45°:

- **4/4: EnergyPlus completes with 0 severe and 0 warnings** (bar its own note that World ignores
  a north axis). Our validator: 0 issues. The matcher, re-run: nothing left to propose.
- **EnergyPlus's own zone report equals the geometry exactly, 4/4**: 30 m² / 90 m³, 20 m² / 60 m³,
  30 m² / 90 m³. Since EnergyPlus falls back to an approximate volume for a zone it cannot close,
  and warns on a flipped surface, this is independent confirmation of every face's orientation.

**From scratch, through the browser.** New → draw a zone by clicking four arbitrary points →
draw a second, reusing two of the first's corners by vertex snapping → the Matching panel
proposes exactly the shared wall, with interior constructions → apply → **+ Door** through the
shared wall (mirrored onto the twin) → **+ Window** on an exterior wall → an oversized window,
refused with the reason. The file from the Changes panel, run in EnergyPlus: **completes, 0
severe**; its one warning is an unused library construction; EnergyPlus's floor areas equal our
footprint areas (69.58, 45.78 m²) and its volumes are exactly those × 3 m.

**The validator against EnergyPlus.**

| Case | EnergyPlus | Us |
|---|---|---|
| A floor and a roof drawn upside down | names both | names the same two |
| A zone left without its roof | names the zone | names the same zone |
| One vertex moved on each gate fixture (the Phase 6 measurement) | 7/7 name one zone | 7/7 name the same zone |
| All 126 current-version corpus files, `DisplayExtraWarnings` on; 100 reach geometry | 0 open zones, 0 upside-down | 0 and 0 — after one fix (below) |

### Discovered en route

- **The validator could not see the two mistakes drawing makes.** The first from-scratch control
  runs had EnergyPlus reporting `Floor is upside down` and `not fully enclosed` while we reported
  nothing: the inverted-normal rule looked only at `Outdoors` surfaces, and there was no
  enclosure rule at all. Both are now EnergyPlus's own algorithm, and the gate asserts the two
  name the same surfaces and zones.
- **Enclosure has to include surfaces that do not exist in the file.** The first corpus comparison
  had 8 false positives in 3 files, all return plenums and similar whose floor is the ceilings of
  the zones below, declared with `Outside Boundary Condition = Zone`. EnergyPlus auto-creates the
  reversed twin in the named zone, and so sees a closed volume. Adding those twins took the
  disagreement to zero.
- **An exterior construction paired to itself is an interzone construction EnergyPlus questions.**
  Two zones drawn side by side each get an exterior wall, and pairing them left
  `does not have the same materials in the reverse order` on every shared wall. The matcher now
  proposes the file's interior constructions for exactly those pairs — and only when the
  replacements really are each other's reverse — and the template's interior ones are
  layer-symmetric so they always are.
- **`window.prompt` and `window.confirm` throw in some embedded browsers.** Drawing a zone failed
  outright there with `prompt() is not supported`, and Phase 6's Move zone and Delete
  confirmations would have too. All five are now an in-app dialog, which also asks for a zone's
  name and height at once and puts the consequences of a deletion above the choice.
- **A screen pixel is not a stable ground point.** An end-to-end test that re-clicked the pixels
  of the first zone's corners missed them by a metre, because the toolbar gained buttons, wrapped,
  and moved the canvas. The app was right; the test was not. Development builds expose the viewer
  as `__cartesViewer` so tests click where a point actually projects.
- **The template needed two objects EnergyPlus asks for.** Without
  `Site:GroundTemperature:BuildingSurface` every ground floor draws a warning; without any output
  request, EnergyPlus warns that it produced nothing.

---

## Phase 9 — Polish and reach · M

- Shareable view state — URL-encoded rather than EPShape's clipboard string.
- Screenshot / image export.
- Exploded and stacked zone display modes (borrowed from Pascal's level display modes;
  genuinely useful for multi-storey review).
- Tier-3 simple-class → detailed conversion, as an **explicit user action**, never automatic.
- Possible MCP server, so an LLM can drive the scene. Pascal has this and nothing in BEM does.
  A protocol, not a framework — cheap to add once the Model layer is stable.

---

## Sequencing rationale

The order is chosen so that **value ships before risk compounds**:

- Phases 1–4 produce a **browser-based IDF validator with 3D context**. That is independently
  useful, has no competitor, and requires zero editing capability.
- Phase 5 adds property editing — useful on its own, and it proves the write path on the easy
  case before geometry math is involved.
- Phases 6–8 are where the real differentiation lands, and by then the round-trip guarantee
  has been continuously exercised for the whole build.

If the project stalls after Phase 4, it is still worth having. That is the test of good phasing.

---

## Principal risks

| Risk | Mitigation |
|---|---|
| **Round-trip fidelity is harder than it looks.** Real IDFs are messy — hand-edited, inconsistent, non-ASCII, version-mixed. | Phase 1's byte-identical gate, run against the full `ExampleFiles/` corpus. Fail fast and fix the parser, not the fixtures. |
| **Coordinate convention sign errors.** Silent, plausible-looking, thermally catastrophic. | ✅ Retired in Phase 2. Known-answer fixtures with hand-computed vertices, written before the resolver, plus spec-derived invariants over the corpus with rotations injected. Verified against `SurfaceGeometry.cc`, not the IO Reference and not memory. |
| **Version drift across EnergyPlus releases.** | EPShape's IDD-preprocessing approach, extended. Regenerate the table when new versions ship. |
| **Scope creep toward thick walls / authoring.** | v1 is explicitly zero-thickness and edit-first. Thickness has a designated attachment point (`04-architecture.md` §Where thickness attaches later) so deferring it costs nothing later. |
| **Validator false positives.** | Triage every finding on the shipped `ExampleFiles/` corpus before release. |

---

## Immediate next steps

Phases 1, 2, 3, and 4 are complete; steps 1–9 below are done. See §Phase 1, §Phase 2, §Phase 3, and §Phase 4 for measured
outcomes.

1. ✅ Obtain `Energy+.idd` for the target version range and write `scripts/preprocess-idd.ts`.
   — 27 releases (7.2 → 26.1) via `scripts/fetch-idd.sh`; table is 112 KB.
2. ✅ Pull the EnergyPlus corpus into `test/fixtures/` — 182 files across 9 versions.
3. ✅ Build the tokenizer and the byte-identical round-trip test. **Green: 245 tests.**
4. ✅ Confirm the ⚠ items in `03-idf-geometry.md` — Tier-3 class list (now emitted from the IDD
   group, not hardcoded), the `GlobalGeometryRules` field count (5, stable across all 27
   releases), and both rotation sign conventions (read from `SurfaceGeometry.cc`).
5. ✅ Build the name index and version-resolved field accessor over `IDD_TABLE`, so model code
   reads `Outside Boundary Condition` by name and never by index.
6. ✅ Implement coordinate resolution per `03-idf-geometry.md` §Coordinate resolution, including
   the Appendix G rotation that applies in World coordinates.
7. ✅ Write the known-answer rotation fixture *before* the resolver. Phase 2 gate met on both
   the hand-derived pair and the 182-file corpus. **Green: 316 tests.**
8. ✅ Implement three.js scene, earcut triangulation (project-to-plane-basis), fat-line outlines,
   on-demand rendering viewer, and UI shell. Phase 3 gate met. **Green: 380 tests.**
9. ✅ Implement validation engine (`src/geometry/validate.ts`), 3D viewport selection, camera
   focusing, and interactive Validation Panel UI. Phase 4 gate met over 182 corpus files. **Green: 401 tests.**
10. ✅ Implement Object Tree, Declarative IDD Property Inspector, in-place field patching emitter,
    live diff engine, and file export. Phase 5 gate met. **Green: 406 tests.**
11. ✅ Implement the inverse coordinate transform (`src/geometry/unresolve.ts`), the vertex/surface
    write path (`src/geometry/edit-geometry.ts`), and the EnergyPlus test harness
    (`test/harness/energyplus.ts`). Phase 6 gate met for the vertex-move slice over 7 fixtures
    against EnergyPlus 26.1.0. **Green: 424 tests.**
12. ✅ Implement snapping (`src/geometry/snap.ts`), the IDD-derived reverse-reference index
    (`src/model/refs.ts`), surface deletion with referential integrity (`src/model/delete.ts`),
    and emitter support for deleted spans. Coherent-corner gate met on 7/7 fixtures with zero
    new warnings. **Green: 449 tests.**
13. ✅ Close both recorded gate weaknesses. Promote the corner move to product code
    (`planCornerMove`, `moveVertices`, `verticesAt`, `verticesOnVerticalEdge`,
    `edgeIsSubdivided`) so the gate tests the shipping path, and add a referential-integrity
    gate (`test/geometry/eplus-refs.test.ts`) that edits and deletes surfaces chosen *because*
    they are paired. Found and fixed two real defects en route: `planCornerMove` was blind to
    geometrically offset twins, and `buildReferenceIndex` was skipping every class outside the
    loaded IDD subset. **Green: 501 tests.**

14. ✅ Add / delete vertex (`src/geometry/edit-vertex-count.ts`) through a new field-splice write
    path and a formatting-preserving spliced renderer in the emitter; whole-zone translate
    (`src/geometry/zone-translate.ts`) across all three coordinate-system fields, with the
    daylighting classes added to the IDD subset. Both gated against EnergyPlus with controls;
    7,222 corpus surfaces split and rejoined byte-identically. **Green: 557 tests.**
15. ✅ Undo / redo at the Document layer (`src/model/history.ts`), 900 corpus steps retraced
    byte-exactly; the viewport gizmo (`src/geometry/drag.ts`, viewer handles and partial
    refresh, App edit modes) wired to `snapPoint`, verified in a browser. **Green: 581 tests.**
    **Phase 6 complete.**

16. ✅ Surface auto-matching (`src/geometry/match.ts`) and its review panel
    (`src/ui/MatchPanel.tsx`). Gate met over all 182 corpus files — 1,535 pairs stripped and
    proposed back exactly, proposals on shipped files only for the triaged defect — and against
    EnergyPlus on three kinds of breakage. Fixed a latent Phase 5 parser bug that lost every edit
    to a blank field. **Green: 614 tests. Phase 7 complete.**

17. ✅ Creation tools: the object-creation write path and emitter placement, an authoring template,
    zone extrusion, windows and doors with containment/coplanarity/4-vertex enforcement and twin
    mirroring, the Draw zone / New / + Window / + Door UI, and an in-app dialog in place of
    browser prompts. Two EnergyPlus rules added to the validator (upside-down surfaces, zone
    enclosure), agreeing with EnergyPlus on every case measured. Gate met under four vertex
    conventions and through the browser. **Green: 654 tests. Phase 8 complete.**

**Next — Phase 9 — Polish and reach.** Shareable view state, image export, exploded/stacked
display, explicit Tier-3 → detailed conversion, and possibly an MCP server.

Still recorded rather than closed:

- **Offset twins in corner moves.** Moving the *other* side of a geometrically offset interzone
  pair needs the twin's corresponding corner matched by proximity. Phase 7 deliberately does not
  match offset faces (a 1 mm plane tolerance), so `planCornerMove` still reports the split
  (`CornerMovePlan.splitPairs`) and leaves the decision to the caller.
- **Partial overlaps are flagged, not split.** A zone drawn against *part* of a neighbour's wall
  gets a partial overlap the matcher reports but cannot pair; the user must draw to the
  neighbour's corners (vertex snapping makes that one click each). Automatic intersection —
  splitting both walls where they meet — is the remaining piece of OpenStudio-style
  intersect-and-match.
- **Creation is rectilinear in section.** Zones are vertical extrusions with flat roofs; sloped
  roofs and non-rectangular openings are available through `createBaseSurface` /
  `createSubSurface` but have no drawing tool.

Carried-forward gaps, all low-risk and recorded rather than forgotten:

- No `.expidf` fixture exists to obtain (see §Phase 1). Revisit if a user reports a failure.
- Fixtures start at 8.3, not the 7.2 the IDD table covers — `testfiles/` did not exist at the
  repo root before v8.3.0.
- **The Appendix G path has no natural corpus coverage.** Exactly one shipped example file
  declares `Compliance:Building` (`LBuildingAppGRotPar.idf`) and its angle is `=$appGAngle` — a
  parametric-preprocessor placeholder no browser can resolve, so the effective angle is 0
  everywhere in the corpus. The path is covered by a hand-authored fixture and by the
  injected-rotation pass, which is enough to kill the mutations, but a concrete Appendix G
  baseline model would still be worth adding if one becomes available.
- Tier-3 rectangular surfaces are counted, not rendered. `GlobalGeometryRules` field 5
  (`Rectangular Surface Coordinate System`) is used only by zone translate, which carries them
  when Relative and lists them in `leftBehind` when World.
  Measured consequence: `4ZoneWithShading_Simple_1.idf` is built entirely from these classes
  and so contains no editable vertex at all.
- **Gizmo gaps.** No on-screen handle for surface translate along its normal (the operation
  exists; only the UI does not), zone translate takes typed offsets rather than a drag, and a
  moved wall's windows stay put — corner mode refuses fenestrated walls for that reason, vertex
  mode lets the validator report the containment break. (The `window.confirm` confirmations noted
  here were replaced by an in-app dialog in Phase 8.)
- **The EnergyPlus gate needs a local binary and a local corpus.** `test/fixtures/` is
  gitignored (fetched, not committed) and E+ is not a package dependency, so the gate
  `describe.skipIf`s itself into silence on a machine without both. It is green locally
  against EnergyPlus 26.1.0; wiring it into CI means solving fixture fetch plus an E+ install.
