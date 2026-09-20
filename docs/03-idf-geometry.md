# 03 — IDF Geometry Reference

Domain knowledge needed to build the parser, renderer, and validator.

| Mark | Meaning |
|---|---|
| ★ | Read from VI-Suite's exporter — trustworthy but second-hand. |
| ✅ | **Verified against primary sources**: the 27 archived `Energy+.idd` files (7.2 → 26.1) and, where the IDD is silent on behaviour, `src/EnergyPlus/SurfaceGeometry.cc` itself. |
| ⚑ | A trap that produces plausible-looking wrong output rather than an error. |

Nothing in this document is now marked ⚠ — every item that was pending verification has been
resolved against the IDD archive or the EnergyPlus source. Facts that the geometry layer will
depend on are pinned by assertions in `test/idd-table.test.ts`, so an upstream change breaks a
test rather than silently changing behaviour.

---

## File format

IDF is a flat, order-independent list of objects:

```
BuildingSurface:Detailed,
    Zone1_Wall_North,        !- Name
    Wall,                    !- Surface Type
    Exterior Wall,           !- Construction Name
    ZONE 1,                  !- Zone Name
    ,                        !- Space Name
    Outdoors,                !- Outside Boundary Condition
    ,                        !- Outside Boundary Condition Object
    SunExposed,              !- Sun Exposure
    WindExposed,             !- Wind Exposure
    autocalculate,           !- View Factor to Ground
    4,                       !- Number of Vertices
    0.0, 10.0, 3.0,          !- X,Y,Z ==> Vertex 1 {m}
    0.0, 10.0, 0.0,          !- X,Y,Z ==> Vertex 2 {m}
    10.0, 10.0, 0.0,         !- X,Y,Z ==> Vertex 3 {m}
    10.0, 10.0, 3.0;         !- X,Y,Z ==> Vertex 4 {m}
```

Rules:
- First token is the **class name**; remaining tokens are **positional fields**.
- `,` separates fields, `;` terminates the object.
- `!` begins a comment to end of line. `!-` is the convention for generated field-name comments.
- Fields are positional — **names come from the IDD, not the file**. The `!- Name` comments
  are decorative and may be absent, stale, or wrong.
- Field values may be empty (`,,`), meaning "use default."
- Class names and most values are case-insensitive; object *names* are case-insensitive for
  reference resolution but should be preserved as written.
- Whitespace around tokens is insignificant.
- `.expidf` is the ExpandObjects output — same grammar, templates already expanded.

**epJSON alternative:** EnergyPlus 9.0+ supports `.epJSON` natively and ships
`ConvertInputFormat` for IDF↔epJSON, plus `Energy+.schema.epJSON`. That would eliminate
custom parsing entirely — but `ConvertInputFormat` is a native binary, so a pure-browser tool
cannot use it. We parse IDF text. Revisit if a local process is ever in scope.

---

## Geometry classes

### Tier 1 — detailed (v1 scope: parse, render, edit)

| Class | Role |
|---|---|
| `Zone` | Thermal zone. Origin, relative north, multiplier, ceiling height, volume, floor area. |
| `BuildingSurface:Detailed` | Walls, floors, roofs, ceilings. N vertices. |
| `FenestrationSurface:Detailed` | Windows, doors, glazed doors. ✅ **3 or 4 vertices only — no `\extensible` marker; the IDD's last slot is literally `N15; Vertex 4 Z-coordinate`.** Base surfaces extend to 120 vertices; sub-surfaces cannot. The editor must refuse to add a 5th vertex to a window rather than emitting an object EnergyPlus will reject. |
| `Shading:Site:Detailed` | Shading fixed in world coordinates. |
| `Shading:Building:Detailed` | Shading that rotates with the building north axis. |
| `Shading:Zone:Detailed` | Shading attached to a base surface. |
| `GlobalGeometryRules` | **Governs interpretation of every vertex in the file.** |
| `Building` | Carries `North Axis`, which rotates relative coordinates. |
| `Compliance:Building` | Carries `Building Rotation for Appendix G` — **rotates geometry even in World coordinates.** |
| `Construction` | Needed for colour-by-construction and validation. |

### Tier 2 — alternate detailed (v1: preserve verbatim, render if cheap)

`Wall:Detailed`, `RoofCeiling:Detailed`, `Floor:Detailed` — same vertex structure as
`BuildingSurface:Detailed` but with surface type implied by the class name.

✅ Verified present in the IDD group `Thermal Zones and Surfaces`, all three extensible with
stride 3. **Absent from all 126 develop-branch test files**, so they are rare in practice but
cheap to support since the vertex layout is identical.

### Tier 3 — simple / parametric (v1: preserve verbatim, do NOT render)

These define geometry by origin + dimensions + angles rather than explicit vertices:
`Wall:Exterior`, `Wall:Adiabatic`, `Wall:Underground`, `Wall:Interzone`, `Roof`,
`Ceiling:Adiabatic`, `Ceiling:Interzone`, `Floor:GroundContact`, `Floor:Adiabatic`,
`Floor:Interzone`, `Window`, `Door`, `GlazedDoor`, `Window:Interzone`, `Door:Interzone`,
`GlazedDoor:Interzone`, `Shading:Site`, `Shading:Building`, `Shading:Overhang`,
`Shading:Overhang:Projection`, `Shading:Fin`, `Shading:Fin:Projection`, `InternalMass`.

✅ **Verified against the v26.1 IDD** — this list is exactly the non-detailed geometry set in
`\group Thermal Zones and Surfaces`. `GEOMETRY_CLASSES` in `idd-table.generated.ts` is emitted
from that group, so the list is now derived rather than asserted.

Measured frequency across the 126-file develop corpus (counted with our own parser, since a
plain grep over-counts — IDF *values* like `Roof,   !- Surface Type` sit at line start too):

| Class | Objects | Files |
|---|---|---|
| `InternalMass` | 447 | 28 |
| `Wall:Exterior` | 32 | 3 |
| `Window` | 17 | 3 |
| `Shading:Overhang` | 10 | 3 |
| everything else | ≤ 8 each | ≤ 3 each |

So outside `InternalMass`, Tier 3 appears in **three files**. Deferring it is cheap; the
"N objects not rendered" banner will fire almost never.

For contrast, Tier 1 in the same corpus: 5680 `BuildingSurface:Detailed`, 884
`FenestrationSurface:Detailed`, 853 `Zone`, 78 `Shading:Zone:Detailed`.

**v1 policy:** if a file contains Tier 3 objects, parse and preserve them byte-faithfully,
show a clear "N objects not rendered" banner, and never silently drop them. Converting simple
→ detailed is a v2 feature; it is lossy in the user's intent and should be an explicit action.

---

## ★ Field orders (verified from VI-Suite `envi_export.py`)

```
GlobalGeometryRules:
  Starting Vertex Position, Vertex Entry Direction, Coordinate System
  # VI-Suite writes: UpperRightCorner, Counterclockwise, World

Zone:
  Name, Direction of Relative North (deg), X Origin (m), Y Origin (m), Z Origin (m),
  Type, Multiplier, Ceiling Height (m), Volume (m3), Floor Area (m2),
  Zone Inside Convection Algorithm, Zone Outside Convection Algorithm,
  Part of Total Floor Area

BuildingSurface:Detailed:
  Name, Surface Type, Construction Name, Zone Name, Space Name,
  Outside Boundary Condition, Outside Boundary Condition Object,
  Sun Exposure, Wind Exposure, View Factor to Ground, Number of Vertices,
  [X, Y, Z] * N

FenestrationSurface:Detailed:
  Name, Surface Type, Construction Name, Building Surface Name,
  Outside Boundary Condition Object, View Factor to Ground,
  Frame and Divider Name, Multiplier, Number of Vertices,
  [X, Y, Z] * N

Shading:Building:Detailed  /  Shading:Site:Detailed:
  Name, Transmittance Schedule Name, Number of Vertices, [X, Y, Z] * N
```

**`Space Name` is a recent addition to `BuildingSurface:Detailed`.** Field positions after it
shift between versions. This is precisely why we drive parsing from a version-keyed IDD table
rather than hardcoded indices.

✅ **Measured across all 27 archived IDDs.** The insertion landed in **9.6** and moved every
field after index 3:

| Field | ≤ 9.5 | ≥ 9.6 |
|---|---|---|
| `Zone Name` | 3 | 3 |
| `Space Name` | — | **4** |
| `Outside Boundary Condition` | **4** | **5** |
| `Number of Vertices` | 9 | 10 |
| first vertex X | 10 | 11 |

Reading `Outside Boundary Condition` at a hardcoded index 4 therefore returns the *space name*
on 9.6+ — usually blank, so surface pairing silently finds no matches instead of erroring.
That is the exact failure mode the table prevents, and it is pinned by a test.

The corpus shows it plainly — same file, two releases:

```
9.3.0/5ZoneAirCooled.idf          24.2.0/5ZoneAirCooled.idf
  WALL-1PF,   !- Name               WALL-1PF,   !- Name
  WALL,       !- Surface Type       WALL,       !- Surface Type
  WALL-1,     !- Construction Name  WALL-1,     !- Construction Name
  PLENUM-1,   !- Zone Name          PLENUM-1,   !- Zone Name
  Outdoors,   !- Outside Boundary…  ,           !- Space Name      ← inserted
  ,           !- OBC Object         Outdoors,   !- Outside Boundary…
```

Across the whole table, 47 classes over 27 releases collapse to **125 distinct field
layouts** — `BuildingSurface:Detailed` alone has 6.

---

## Coordinate resolution — the part EPShape skips

✅ **`GlobalGeometryRules` has exactly 5 fields** in every version from 7.2 to 26.1 (verified
against all 27 archived IDDs). The first three are `\required-field` with no default; the
last two default to `Relative`, so a 3-field object is legal and common.

| # | Field | Choices | Default |
|---|---|---|---|
| 0 | Starting Vertex Position | UpperLeftCorner, LowerLeftCorner, UpperRightCorner, LowerRightCorner | *required* |
| 1 | Vertex Entry Direction | Counterclockwise, Clockwise | *required* |
| 2 | Coordinate System | Relative, World | *required* |
| 3 | Daylighting Reference Point Coordinate System | Relative, World | Relative |
| 4 | Rectangular Surface Coordinate System | Relative, World | Relative |

Only field 2 governs the vertices we render. Fields 3–4 apply to daylighting reference points
and to the Tier-3 rectangular classes respectively — both out of scope for v1, but they must be
**preserved**, and field 4 becomes load-bearing the moment Tier 3 is rendered.

**1. `Coordinate System` — `World` | `Relative`**
- `Relative`: vertices are relative to the **zone origin**, then rotated. See the algorithm below.
- `World`: vertices are absolute — *but not untransformed.* See the Appendix G trap.

**2. `Starting Vertex Position`** and **3. `Vertex Entry Direction`** together fix the vertex
order EnergyPlus works in. Only **`Vertex Entry Direction`** affects the **surface normal**,
which EnergyPlus uses to decide which side faces outdoors — get that wrong and the model is
thermally inverted while looking visually identical. `Starting Vertex Position` is a cyclic
relabel and leaves the normal alone; see the ordering algorithm below.

### ✅ Vertex ordering (`GetVertices`, verified against the source)

Two steps, in this order:

1. **`Vertex Entry Direction`.** A `Clockwise` file is normalised by keeping vertex 1 and
   reversing the rest — `[v1, vN, vN-1, …, v2]`. This **flips the normal**.
2. **`Starting Vertex Position`.** Left-rotate the list so the named corner comes first.

The rotation count comes from a `while` loop that walks the corner index forward to
`UpperLeftCorner`, each pass swapping its way once around the ring. Each pass is exactly one
left-rotate-by-1 *whatever the starting index*, so in closed form:

```
shifts = (nSides - corner + 1) mod nSides
```

with corners numbered from the C++ `FlCorners` array — **UpperLeft 1, LowerLeft 2, LowerRight
3, UpperRight 4**. ⚑ That is *not* the IDD `\key` order, which lists UpperRight before
LowerRight; taking the numbering from the IDD swaps two of the four corners.

The loop also breaks early when `nSides < 4` and the corner is `UpperRightCorner`, but that
changes nothing — the formula already yields 0 at three sides.

Because a left-rotate is a **cyclic relabel**, and Newell's method sums over closed edges, the
corner shift cannot change the normal. It does change *which field a vertex lives in*, so an
editor must keep the permutation around: dragging resolved vertex `i` has to write back to
source vertex `sourceIndex[i]`, or an edit on a `Clockwise` file lands on the wrong three
fields.

### ⚑ The Appendix G trap

`World` does **not** mean "no transform". `Compliance:Building`'s `Building Rotation for
Appendix G` is applied to every vertex *even in World coordinates* — EnergyPlus rotates by
that angle alone, skipping only the building north axis and zone origin.

```cpp
// SurfaceGeometry.cc — the World branch
CosBldgRotAppGonly = cos(-BuildingRotationAppendixG * DegToRad);
x = Xb * CosBldgRotAppGonly - Yb * SinBldgRotAppGonly;
```

A viewer that treats World as identity will silently disagree with EnergyPlus for any
Appendix G baseline model — which is to say, for a large share of code-compliance work.

### ✅ Resolution algorithm (read from `SurfaceGeometry.cc`, not inferred)

Both angles are **negated** before the sine/cosine, and then fed through the standard
counter-clockwise matrix `[x·cos − y·sin, x·sin + y·cos]`. Net effect: a **clockwise rotation
by the stated angle**, viewed from +Z looking down — i.e. *degrees clockwise from true north*,
the surveyor's convention.

```
θ_zone = -zone.directionOfRelativeNorth
θ_bldg = -(building.northAxis + compliance.appendixGRotation)

if coordinateSystem == Relative and surface belongs to a zone:
    xb = x·cos(θ_zone) - y·sin(θ_zone) + zone.originX
    yb = x·sin(θ_zone) + y·cos(θ_zone) + zone.originY
    x' = xb·cos(θ_bldg) - yb·sin(θ_bldg)
    y' = xb·sin(θ_bldg) + yb·cos(θ_bldg)
    z' = z + zone.originZ

elif coordinateSystem == Relative and class is Shading:Building:Detailed:
    # building-attached shading rotates, but has no zone origin
    x' = x·cos(θ_bldg) - y·sin(θ_bldg)
    y' = x·sin(θ_bldg) + y·cos(θ_bldg)
    z' = z

else:  # World — Appendix G only, and only for the same two cases
    θ_g = -compliance.appendixGRotation
    if surface belongs to a zone, or class is Shading:Building:Detailed:
        x' = x·cos(θ_g) - y·sin(θ_g)
        y' = x·sin(θ_g) + y·cos(θ_g)
    else:                      # Shading:Site:Detailed
        x', y' = x, y
    z' = z
```

Three details that are easy to get wrong and are settled by the source:

- **The zone-origin translation happens *inside* the building rotation.** The origin is added
  before `θ_bldg` is applied, so rotating the building sweeps the zone origins around the site
  origin. Translating first and rotating after — or rotating the vertices but not the origin —
  both produce plausible-looking, wrong buildings.
- **Z is never rotated**, and `zone.originZ` is added independently of the XY pipeline.
- **`Shading:Site:Detailed` receives no transform at all** — in *either* branch. The World
  branch repeats the same `ZoneNum > 0` / `Detached_B` guards as the relative branch, so site
  shading escapes even the Appendix G rotation. Site shading is genuinely fixed, which is the
  whole distinction between `Shading:Site:*` and `Shading:Building:*`.

**Attached shading takes its zone from its base surface.** `Shading:Zone:Detailed` names a
base surface, not a zone, but EnergyPlus copies the base surface's zone onto it — which is
precisely what makes relative coordinates work for it. A resolver that treats attached shading
as zone-less puts every overhang at the site origin. The same inheritance applies to
sub-surfaces: a `FenestrationSurface:Detailed` resolves through its base surface's zone.

Use **Newell's method** for the normal, not a cross product of the first three vertices —
IDF polygons can be near-degenerate at a corner, and Newell's is robust and simultaneously
gives you a planarity residual for free.

---

## Units and axes

- EnergyPlus is **metres**, always. No unit field.
- EnergyPlus is **Z-up**, right-handed. X east, Y north, Z up.
- three.js defaults to **Y-up**.

**Decision: store everything in EnergyPlus Z-up coordinates. Never mutate stored coordinates
for display.** Apply a single rotation on a root `Object3D` (or set
`THREE.Object3D.DEFAULT_UP`) so the camera behaves naturally.

Rationale: the document is the source of truth, and round-trip fidelity is the product. Every
place we convert coordinates is a place a rounding error or an axis flip can leak back into
the file. One conversion, at the display boundary, auditable.

---

## Triangulation

WebGL needs triangles; IDF surfaces are arbitrary planar polygons, possibly concave.

**earcut is 2D only.** The pipeline is:

1. Compute the polygon normal (Newell).
2. Build an orthonormal basis in the polygon plane.
3. Project all vertices to 2D in that basis.
4. `earcut(flatCoords2D)` → triangle indices.
5. Use those indices against the **original 3D vertices**.

Do not project by simply dropping the smallest-magnitude normal component — it works but
degrades on steeply sloped surfaces. A proper basis is barely more code.

Fenestration must be cut from, or rendered in front of, its base surface. Simplest v1
approach: render fenestration slightly offset along the base surface normal (~1 mm) to avoid
z-fighting, rather than doing real CSG. Revisit only if it looks wrong.

---

## Validation rules

EnergyPlus is strict, and its errors are cryptic. A good validator is a major part of this
tool's value — arguably more valuable than editing.

**Hard errors (E+ will fail or silently misbehave):**
- Non-planar surface. E+ tolerance is small; compute max deviation from the best-fit plane.
- `FenestrationSurface:Detailed` with more than 4 vertices → VI-Suite raises an error here.
- Fenestration not coplanar with, or not contained within, its base surface.
- Fewer than 3 vertices; zero-area or degenerate surfaces; duplicate consecutive vertices.
- Self-intersecting polygon.
- `Outside Boundary Condition = Surface` with an `Outside Boundary Condition Object` that
  does not exist, or that does not point back symmetrically.
- Paired surfaces with mismatched vertex counts. *(VI-Suite downgrades these to `Adiabatic`
  and logs — we should surface it as a fixable warning instead.)*
- Unenclosed zone — E+ needs a closed volume to compute volume and view factors.
- Dangling references: `Construction Name`, `Zone Name` pointing at nothing.

**Warnings:**
- Paired surfaces with mismatched constructions / U-values. *(VI-Suite logs this and lets one
  side take precedence.)*
- Surface normal pointing the wrong way (inward for an exterior surface).
- `Sun Exposure` / `Wind Exposure` inconsistent with the boundary condition — e.g.
  `SunExposed` on a surface whose OBC is `Surface` or `Ground`.
- Zone with no floor surface, or `Volume`/`Floor Area` hardcoded rather than `autocalculate`
  and inconsistent with geometry.

**Round-trip validator (ours, not E+'s):**
- Parse → re-emit → byte-diff must be empty for an untouched file. This is the gate for
  everything else. See `05-implementation-plan.md` Phase 1.

---

## Boundary conditions

`Outside Boundary Condition` values relevant to geometry:

| Value | `OBC Object` | Sun/Wind | Meaning |
|---|---|---|---|
| `Outdoors` | empty | usually exposed | Exterior |
| `Surface` | name of paired surface | `NoSun`, `NoWind` | Interzone — paired both ways |
| `Zone` | zone name | `NoSun`, `NoWind` | E+ auto-creates the pair |
| `Adiabatic` | empty | `NoSun`, `NoWind` | No heat transfer |
| `Ground` | empty | `NoSun`, `NoWind` | Ground contact |
| `OtherSideCoefficients` / `OtherSideConditionsModel` | object name | — | Advanced |

**The `Surface` pairing is symmetric and must stay consistent.** If the user deletes or
reshapes surface A, surface B's reference breaks. Any edit touching a paired surface must
either update the twin or flag the break. This is the main referential-integrity hazard in
the editor.

**Geometric auto-matching** — finding which surfaces are coincident-and-opposed and wiring
the pair automatically — is *not* implemented in VI-Suite (it relies on manual node wiring).
OpenStudio and geomeppy (Shapely-based) do it. This is our differentiator; see
`04-architecture.md`.
