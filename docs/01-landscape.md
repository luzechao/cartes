# 01 — Landscape

Why this project exists, and what it is competing with. All claims here were verified against
primary sources (repo metadata, source code, official docs) rather than recalled — where a
claim is inferred rather than confirmed, it is marked.

## The ecosystem is made of generators

Every mature tool for building EnergyPlus geometry works the same way: you author in the
tool's native model, and the tool *forward-translates* to IDF. The IDF is an output artifact.
None of them can reopen it.

### OpenStudio SketchUp Plug-in
- Ruby, SketchUp extension, maintained by the OpenStudio Coalition (last push 2026-04-07).
- **Does not edit IDF.** It edits `.osm` (OpenStudio Model) via the OpenStudio SDK. OSM → IDF
  is a one-way forward translation at simulation time. IDF → OSM reverse translation exists
  but is lossy and mostly geometry-only.
- Depends on the OpenStudio Application; version compatibility is managed by a published matrix.
- Requires SketchUp Pro (free desktop SketchUp ended after 2017; SketchUp Free is
  browser-only and cannot run extensions).

### Euclid (Big Ladder)
- The successor to NREL's Legacy OpenStudio plug-in, after NREL dropped support.
- **The only tool that reads and writes EnergyPlus geometry in native IDF.**
- **Effectively dead:** per Big Ladder's own page, "for 2024 or later, Euclid will not work
  due to Ruby version incompatibility." Free desktop SketchUp died after 2017 anyway.
- This is the tool idf-editor is replacing.

### VI-Suite (Blender)
- Free (GPL v2), cross-platform, actively maintained (last push 2026-08-06, targets Blender 5.1).
- Genuinely writes IDF — confirmed at source level, not inferred. See `02-prior-art.md`.
- **Write-only.** Grepped `envi_export.py`, `envi_func.py`, `vi_operators.py`, `vi_func.py`
  for any IDF read/import/parse path: zero hits. You cannot open an existing IDF in it.
- Whole toolchain below it is free: Blender + EnergyPlus + Radiance + OpenFOAM.

### Ladybug Tools
- Not web-based. Ladybug, Honeybee, Dragonfly, Butterfly all run *inside* Grasshopper/Rhino.
- Only peripheral pieces are browser-hosted: EPWmap (weather-file locator) and Design Explorer
  (contributed to, not owned).
- Requires Rhino (commercial; Grasshopper only ships inside it).

### Pollination
- Documented products are three desktop CAD plugins: Revit, Rhino, Grasshopper.
- A portal exists at `app.pollination.solutions` (login, trial, plugin downloads, cloud
  simulation runs), but neither the marketing site nor the user manual documents a
  browser-based model editor.
- Exports to HBJSON, DFJSON, OSM, gbXML, GEM, **IDF**, INP, IDM, SDDXML — all as plugin
  capabilities, all one-way.
- *Unverified:* the org has ~64 repos and uses TypeScript; a web viewer component may exist
  somewhere not surfaced in the docs. "No documented web editor" is solid;
  "no web viewer anywhere" is not established.

### FloorspaceJS (NREL)
- **Browser-based and it edits geometry** — so the "browser + editing" intersection is not
  empty. Vue.js, embedded into the OpenStudio Application via `npm run openstudio-build`,
  imported through an OpenStudio measure.
- Not archived; last push 2026-02-09; 83 stars. Low activity but alive.
- **2D floorplan only, and targets OSM, not IDF.**

### EPShape
- Browser-based, three.js, MIT, no build step, no install.
- **Read-only viewer.** Opens `.idf` / `.expidf`, renders zones, surfaces, fenestration,
  shading. Tested for EnergyPlus 8.9.0+.
- The closest thing to idf-editor that exists, and the single most useful prior art.
  See `02-prior-art.md`.

## The actual gap

Sorted by the one axis that matters — *can it open an IDF someone else wrote, and change it?*

The intersection that is empty is narrow and specific:

> **browser-native + 3D geometry editing + IDF-native + lossless round-trip**

- FloorspaceJS is browser + editing, but 2D and OSM-targeted.
- VI-Suite is 3D + IDF, but desktop, write-only, and inherits Blender's UX — a real barrier
  for energy modelers who are not Blender users.
- EPShape is browser + IDF, but read-only.
- Euclid was all four, and no longer runs.

## Who this is for

Price is the weaker argument. Most working BEM practitioners already have Rhino or Revit
through their firm, so "free" alone will not pull them off Pollination or Ladybug Tools.

The stronger arguments:

1. **Zero-install and shareable.** A URL that opens someone else's model in 3D, with no
   license check and no install. That is a collaboration and QA-review story, not a cost story.
   Nothing in this space offers it.
2. **Round-trip, not generation.** The people who need this are the ones who *received* an
   IDF — reviewers, QA, students inheriting a model, consultants debugging someone else's
   file, researchers running parametrics on a published model. Every existing tool tells them
   to rebuild it from scratch.
3. **The free options are 2D or awkward.** A student, an academic, a solo consultant, or
   anyone on a borrowed machine currently chooses between drawing 2D floorplans in
   FloorspaceJS or learning Blender.

Platform matters too, independent of price: Revit is Windows-only.

## Decision: build standalone, not as a Pascal plugin

Considered building this as a plugin to [Pascal Editor](https://github.com/pascalorg/editor)
(React Three Fiber + WebGPU, 21k stars, explicit third-party plugin API). Rejected.

**Reason:** Pascal's value is concentrated in a domain model this project must bypass. Its
Site → Building → Level → Wall/Slab hierarchy is a *parametric architectural* model — walls
have centerlines, thickness, and height; levels are flat and stacked. Arbitrary IDF polygon
soup does not decompose into that. A surface-native model would use none of `WallSystem`
(mitering, CSG cutouts), `SlabSystem`, `RoofSystem`, `ItemSystem`, or the drawing tools —
i.e. everything that justifies adopting Pascal. You would keep the chassis and discard the
domain layer, which is backwards.

**Cost of adopting it anyway:** a documented-unstable plugin API (plugin nodes are not
first-class in the type system — `createNode` casts against a hand-maintained `AnyNode`
union; floor-placement helpers "aren't part of the public `@pascal-app/*` surface yet";
instance matrices don't refresh on building move) riding on Next.js 16 + React 19 + WebGPU +
Turborepo + Bun under fast upstream development. A permanent impedance layer plus a breakage
treadmill, paid against exactly the layer this project cares most about.

**What we give up:** Pascal's MCP integration — an LLM-drivable scene — is genuinely novel
and nothing else in BEM has it. But MCP is a protocol; a server can be added to our own tool
later. It is not a reason to inherit a framework.

**Existence proof that the chassis is cheap:** EPShape is a complete IDF renderer with
picking, camera, and metadata display in ~70 commits, three.js + earcut, no build step, no
dependencies. Rendering is not the bottleneck. Everything else Pascal offers — undo/redo,
persistence, state — is available as commodity libraries (`zustand`, `zundo`, `dexie`).

**What would have flipped this:** if the goal included full architectural authoring (draw a
building from scratch, thick walls, parametric levels), Pascal's parametric layer becomes an
asset rather than dead weight. With v1 scoped to zero thickness and surface-native editing,
it is dead weight.
