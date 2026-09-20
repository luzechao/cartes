# 04 — Architecture

## The one constraint that drives everything

> **The IDF document is the source of truth. Editing rewrites only the objects that changed.
> Everything else is emitted exactly as it was read.**

IDF files are mostly *not* geometry — schedules, constructions, materials, internal loads,
HVAC, EMS programs, output requests. A geometry editor that re-serializes the whole file from
its own model will destroy work it never understood. That is why every existing tool is a
one-way generator: generating is safe, round-tripping is not.

Getting this right is the product. Everything below follows from it.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  UI            React panels · inspector · validation report  │
├──────────────────────────────────────────────────────────────┤
│  Scene         three.js meshes · picking · selection · camera│
├──────────────────────────────────────────────────────────────┤
│  Geometry      resolved world vertices · triangulation ·     │
│                normals · surface pairing · validation        │
├──────────────────────────────────────────────────────────────┤
│  Model         typed, editable entities for geometry classes │
│                Zone · Surface · Fenestration · Shading       │
├──────────────────────────────────────────────────────────────┤
│  Document      ALL IDF objects, verbatim, in original order  │
│                ← lossless round-trip guaranteed here         │
└──────────────────────────────────────────────────────────────┘
```

Data flows down on load, up on save. The Document layer never loses information; the Model
layer is a *typed projection* of the subset we understand.

---

## Layer 1 — Document

A text-preserving parse. Each object retains enough original form to be re-emitted byte-identically.

```ts
interface IdfObject {
  id: string              // synthetic, stable across the session
  className: string       // as written, e.g. "BuildingSurface:Detailed"
  fields: IdfField[]      // positional
  leadingComments: string[]
  dirty: boolean          // false → re-emit rawText verbatim
  rawText: string         // original source slice
}

interface IdfField {
  value: string           // as written, whitespace-trimmed
  comment?: string        // trailing !- comment
}

interface IdfDocument {
  objects: Map<string, IdfObject>
  order: string[]                       // original file order
  byClass: Map<string, string[]>        // class name → object ids
  header: string                        // leading comments before first object
  version: string                       // from the Version object
}
```

**Emit rule:** if `!dirty`, write `rawText` unchanged. If `dirty`, regenerate from `fields`
using the IDD field names for `!-` comments. This means an untouched file round-trips
perfectly by construction, and a file where one surface moved differs in exactly one object.

**Name resolution:** IDF references are by name and case-insensitive. Maintain a
`Map<lowercasedName, objectId>` index. Preserve original casing on write.

---

## Layer 2 — Model

Typed entities for the classes we understand. Each holds a back-reference to its `IdfObject`.

```ts
interface Surface {
  id: string              // = IdfObject id
  name: string
  surfaceType: 'Wall' | 'Floor' | 'Roof' | 'Ceiling'
  construction: string
  zone: string
  outsideBoundaryCondition: string
  outsideBoundaryConditionObject: string
  sunExposure: string
  windExposure: string
  vertices: Vec3[]        // AS WRITTEN — not coordinate-resolved
  fenestration: string[]  // ids of child FenestrationSurface objects
}
```

Two rules that keep this honest:

1. **`vertices` stores raw file values, never resolved world coordinates.** Resolution
   (relative → world, north-axis rotation) happens in Layer 3 and is never written back.
   Otherwise a `Relative`-coordinate file silently becomes a `World` file on save.
2. **Model → Document writes are field-level.** Moving a vertex sets exactly the affected
   fields and marks the object dirty. It does not rebuild the object.

The **field-name table from the IDD** (EPShape's technique, see `02-prior-art.md`) is what
maps positional fields to these named properties, per EnergyPlus version. That same table
drives a generic property inspector for *every* class — including ones we do not model — which
gives us a full IDF object editor almost for free.

---

## Layer 3 — Geometry

Derived, cached, never persisted.

```ts
interface ResolvedSurface {
  id: string
  worldVertices: Vec3[]   // after relative → world, north-axis rotation
  normal: Vec3            // Newell's method
  planarityError: number  // max deviation from best-fit plane
  triangles: Uint32Array  // earcut indices into worldVertices
  area: number
  centroid: Vec3
}
```

Recomputed only for **dirty** surfaces (Pascal's dirty-node pattern). A model with thousands
of surfaces must not retriangulate on every frame or every edit.

Also owns:
- **Validation** — the rule set in `03-idf-geometry.md` §Validation.
- **Surface pairing** — see below.

### Surface auto-matching (the differentiator)

VI-Suite makes the user wire adjacency by hand. OpenStudio and geomeppy do it geometrically.
We do it geometrically, and we do it *incrementally* as an assist rather than a batch operation.

Sketch:
1. Bucket surfaces by plane — quantized (normal, plane-offset), with tolerance.
2. Within a bucket, find pairs whose 2D projections overlap and whose normals are opposed.
3. Classify: full overlap → clean `Surface` pair. Partial overlap → needs splitting, flag it.
4. Propose, don't impose: show the user what would change and let them accept.

**Never silently rewrite boundary conditions.** A user opening someone else's model and
finding 200 surfaces reassigned would rightly not trust the tool again.

---

## Layer 4 — Scene

Direct three.js. Not React Three Fiber.

Borrowed from Pascal: a **scene registry** mapping document id ↔ `Object3D`, plus a `byType`
index, so picking and selection never traverse the scene graph.

- One `Mesh` per surface (`BufferGeometry` from `ResolvedSurface`).
- Edges via `Line2` / `LineSegments2` / `LineMaterial` — three.js's `LineBasicMaterial`
  ignores `linewidth` on most platforms. EPShape bundles these for exactly this reason.
- Fenestration offset ~1 mm along the base normal to avoid z-fighting (no CSG in v1).
- Root object carries the single Z-up → Y-up rotation. Nothing else converts coordinates.
- Render on demand, not in a continuous `requestAnimationFrame` loop — this is a CAD-style
  tool, not a game. Redraw on camera move, selection change, or dirty-geometry flush.

**WebGL2, not WebGPU.** Pascal is WebGPU-first; we should not be. Reach matters more than
render features for a tool whose selling point is "opens anywhere, no install."

---

## Layer 5 — UI

React for panels and chrome only — the 3D viewport is plain three.js in a canvas.

Panels: object tree (by zone), inspector (declarative, driven by the IDD field table),
validation report, raw-IDF text view with live diff, visibility controls.

**Take EPShape's visibility vocabulary wholesale** — it is well-judged for BEM review work:
zones toggled individually, by height range, or both; hidden objects render as `disable` /
`wireframe` / `ghost` rather than vanishing; colour by surface type or by construction.

**Take the live IDF diff idea from VI-Suite** (which loads its output back into Blender's text
editor). Showing the user exactly which text changed is the single best trust-building
affordance this tool can have, given that the whole pitch is "we won't destroy your file."

---

## State

```
zustand store
  ├─ document      IdfDocument
  ├─ selection     Set<objectId>
  ├─ visibility    per-zone, per-type, height range
  └─ view          camera, display mode

zundo wrapper → undo/redo
```

**Undo operates on the Document layer**, not the Scene. An undo step is a set of field-level
changes to `IdfObject`s. This keeps history small, makes it serializable, and means undo can
never desynchronize the document from what gets written to disk.

Persistence: IndexedDB (via `dexie`) for session recovery. No backend.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Stated requirement |
| Build | Vite | Between EPShape's zero-build and Pascal's Turborepo/Bun |
| 3D | three.js (direct) | Scene is generated from a document model; React reconciliation buys nothing and costs control |
| Triangulation | earcut | Proven by EPShape for exactly this |
| Fat lines | `Line2` / `LineMaterial` | `linewidth` is ignored on most platforms |
| State | zustand | Same as Pascal; small, unopinionated |
| Undo | zundo | Same as Pascal; near-free |
| Persistence | dexie | IndexedDB wrapper |
| UI | React | Panels only, not the viewport |
| Tests | Vitest | Round-trip fidelity tests are the backbone |

**No backend.** Everything runs client-side. This is EPShape's superpower and the reason it
still works years later.

### Rejected

- **React Three Fiber** — good when the scene mirrors a React tree. Ours mirrors a document
  model with its own dirty-tracking; R3F adds a reconciliation layer between us and the
  problem.
- **Pascal Editor as a host** — see `01-landscape.md` §Decision.
- **epJSON as internal format** — cleaner and schema-backed, but `ConvertInputFormat` is a
  native binary and we are browser-only.
- **WebGPU-first** — reach beats render features here.

---

## Where thickness attaches later

v1 is zero-thickness: surfaces are the atoms, model is 1:1 with IDF, round-trip is tractable.

If thick walls are ever wanted, they attach as a **sixth layer above Model**, not by changing
it:

```
PhysicalModel   Wall { centerline, thickness, height, ownedSurfaces[], planeConvention }
      ↕ derives / infers
Model           Surface { vertices[], ... }        ← unchanged
```

On import, thickness would be *inferred*: resolve each surface's `Construction` → sum
`Material` layer thicknesses → pair interzone surfaces via `Outside Boundary Condition
Object` → detect the authoring convention automatically (paired surfaces coincident ⇒
centerline-modeled; offset by ~t ⇒ inner-face-modeled).

This is the BIM physical ↔ analytical split, and it is genuinely hard. Keeping it strictly
above the Model layer means v1 never pays for it, and v2 does not require a rewrite.
