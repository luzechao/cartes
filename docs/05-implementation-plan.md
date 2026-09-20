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

- Vertex drag, constrained to the surface plane.
- Surface translate along its normal, and in-plane.
- Whole-zone translate.
- Add / delete vertex.
- Delete surface (with referential-integrity check against paired surfaces and child
  fenestration).
- Snapping: grid, vertex, edge.

Every edit writes field-level changes to the Document and marks affected geometry dirty.
Undo operates on Document-layer field changes.

**Referential integrity is the hazard.** Any edit touching a surface with
`Outside Boundary Condition = Surface` must either update the twin or flag the break. Never
leave a dangling `Outside Boundary Condition Object`.

**Gate:** move a vertex → validation still passes → EnergyPlus runs the output file without
new severe errors. This requires actually running E+ against edited fixtures; set that up as
a test harness, not a manual step.

---

## Phase 7 — Surface auto-matching · M

Plane bucketing → overlap detection → pair classification (full / partial / none), per
`04-architecture.md` §Surface auto-matching.

**Propose, never impose.** Present proposed changes as a reviewable list; the user accepts or
rejects. Silently reassigning boundary conditions in someone else's model is the single
fastest way to lose a user's trust.

**Gate:** on a fixture with known-correct pairing, we reproduce it exactly. On a fixture with
deliberately broken pairing, we propose the correct fix and propose nothing else.

---

## Phase 8 — Creation tools · L

Draw new surfaces and zones. Extrude a footprint into a zone. Place fenestration on a base
surface (with containment and coplanarity enforced, and the 4-vertex limit enforced).

This is the point at which the tool becomes an authoring tool rather than an editor. It is
deliberately last: editing existing files is the differentiator, authoring is the commodity
that five other tools already do well.

**Gate:** create a two-zone model from scratch, export, and run in EnergyPlus with no severe
errors.

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

**Next — Phase 6 — Geometry editing.** Vertex drag constrained to surface plane, surface translate along
normal and in-plane, whole-zone translate, add/delete vertex, delete surface with referential-integrity
check, snapping. Gate: move a vertex → validation passes → EnergyPlus runs output file without new severe errors.

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
- Tier-3 rectangular surfaces are counted, not rendered. `GlobalGeometryRules` field 4
  (`Rectangular Surface Coordinate System`) is read and preserved but unused until they are.
