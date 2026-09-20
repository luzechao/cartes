# 02 — Prior Art: What to Take, What to Avoid

Source-level study of the three reference projects. Everything below was read from the actual
repositories, not recalled.

---

## EPShape — `chp-rubicell/EPShape`

Browser IDF viewer. three.js + earcut. MIT. **The most directly applicable prior art**, and
the architectural template for our read path.

### Repository shape

```
index.html              49 KB    — the whole app shell
resources/scripts.js   122 KB    — application logic (unminified)
resources/lib/
  three.js            1167 KB
  earcut.js             20 KB    — polygon triangulation
  iddLibrary.js         25 KB    — PREPROCESSED IDD (see below)
  jszip.min.js          97 KB
  Line2.js / LineGeometry.js / LineMaterial.js / LineSegments2.js / LineSegmentsGeometry.js
  exampleIDF.js
preprocessIDD/
  process_idd.py                 — generates iddLibrary.js
  idds/                          — 25 raw Energy+.idd files
```

No build step. No package manager. Ships as static files on GitHub Pages. **For a tool that
must still run in five years with low maintenance, this is a superpower** — worth weighing
against the ergonomics of a real toolchain.

### ★ The key idea: preprocess the IDD into a version-keyed field-name table

This is the single most valuable thing to take. `preprocessIDD/process_idd.py` reads 25
official `Energy+.idd` files (V7.2.0 through V25.1.0) and, for each version, extracts the
**ordered field-name list** for a handful of geometry classes:

```python
version_list = ['7_2_0', '8_0_0', ... '24_2_0', '25_1_0']   # 25 versions

if name in ['Zone',
            'Construction',
            'BuildingSurface:Detailed',
            'FenestrationSurface:Detailed',
            'Shading:Building:Detailed']:
    curr_library[name.lower()] = [0] + [
        f[1].lower() for f in fields
        if (f[1] == 'Vertex 1 X-coordinate'
            or not (f[1].startswith('Vertex') and f[1].endswith('coordinate')))
    ]

# → resources/lib/iddLibrary.js:  const versionLibrary = {...};   (25 KB)
```

Two details that make it small:
- Only the classes that carry geometry are extracted. The other ~900 IDD classes are ignored.
- The repeating vertex fields are **collapsed** — everything after `Vertex 1 X-coordinate` is
  dropped, because vertices are positional and extensible (`\extensible:3` in the IDD). The
  parser just reads triples to the end of the object.

The runtime parser then: read the `Version` object → look up that version's field-name array →
split the IDF object on commas → zip positional values against names.

**This solves EnergyPlus version drift for ~25 KB and one offline script.** It is why EPShape
can claim support for 8.9.0+ without a schema engine.

### Gaps in EPShape worth fixing in ours

Directly visible from the class list above — it extracts only five classes. Consequences:

1. **No `GlobalGeometryRules`.** So it cannot honor `Relative` coordinates, non-default
   `Starting Vertex Position`, or `Vertex Entry Direction`. It effectively assumes
   `World` / counterclockwise. Any IDF authored in relative coordinates will render wrong.
   *(The README mentions drawing the building north axis in debug mode, so `Building` must be
   read somewhere — but it is not in the preprocessed class list. Worth confirming in
   `scripts.js` before relying on either behavior.)*
2. **No `Shading:Site:Detailed` or `Shading:Zone:Detailed`** — only `Shading:Building:Detailed`.
3. **No alternate detailed classes** — `Wall:Detailed`, `RoofCeiling:Detailed`, `Floor:Detailed`.
4. **No simple/parametric geometry classes** — `Wall:Exterior`, `Window`, `Door`, `Roof`,
   `Shading:Overhang`, etc. Models using these render as nothing.
5. **Read-only**, so no round-trip fidelity concerns — it never has to write anything back.
   We do, which is a strictly harder problem.

### Other things to take

- **earcut for triangulation.** IDF surfaces are arbitrary planar polygons; WebGL needs
  triangles. Note earcut is **2D only** — see `03-idf-geometry.md` §Triangulation for the
  project-to-2D step this requires.
- **`Line2`/`LineSegments2`/`LineMaterial`.** three.js's native `LineBasicMaterial` ignores
  `linewidth` on most platforms. EPShape bundles the fat-line helpers instead. Take this —
  crisp surface edges are most of what makes a BEM viewer legible.
- **Settings serialized to a clipboard string**, e.g.
  `##EPShpSttgs##;zv:0;sh:1;et:-1;hm:2;cp:8.6/8.4/2.3;` with `ctrl+shift+c` / `ctrl+shift+v`.
  Cheap, effective way to share a view without a backend. Consider URL-encoding instead.
- **Visibility model.** Zones toggled individually, by height range, or both; hidden objects
  render as `disable` / `wireframe` / `ghost` rather than vanishing. Colour by surface type or
  by construction. This is the right vocabulary for BEM review work.
- **Hover metadata** — name, construction, zone on mouseover. Table stakes.
- **`?mult=1.5` URL parameter** scales viewport resolution. Trivial, useful for screenshots.

---

## VI-Suite — `rgsouthall/vi-suite07`

Blender add-on. GPL v2. Free, cross-platform, actively maintained (last push 2026-08-06,
targets Blender 5.1). **The authoritative reference for what correct IDF output looks like.**

Scope well beyond geometry: EnergyPlus (EnVi), Radiance (LiVi), OpenFOAM (FloVi), static and
parametric runs driven by Blender's animation system, natural-ventilation airflow networks
(`writeafn`), an experimental EMS node interface, PV via a Sandia database, plus bundled
material/construction JSON — including a 122 KB embodied-carbon database.

`envi_export.py` is 71 KB and is essentially a complete geometry→IDF writer.

### ★ Verified field orders — copy these, they are ground truth

From `envi_export.py`. These are the exact parameter tuples it emits:

```python
# GlobalGeometryRules
('Starting Vertex Position', 'Vertex Entry Direction', 'Coordinate System')
('UpperRightCorner',         'Counterclockwise',       'World')

# Zone
('Name', 'Direction of Relative North (deg)', 'X Origin (m)', 'Y Origin (m)', 'Z Origin (m)',
 'Type', 'Multiplier', 'Ceiling Height (m)', 'Volume (m3)', 'Floor Area (m2)',
 'Zone Inside Convection Algorithm', 'Zone Outside Convection Algorithm',
 'Part of Total Floor Area')

# BuildingSurface:Detailed   (wfrparams + vertex triples)
['Name', 'Surface Type', 'Construction Name', 'Zone Name', 'Space name',
 'Outside Boundary Condition', 'Outside Boundary Condition Object',
 'Sun Exposure', 'Wind Exposure', 'View Factor to Ground', 'Number of Vertices']
 + ["X,Y,Z ==> Vertex {n} (m)", ...]

# FenestrationSurface:Detailed
['Name', 'Surface Type', 'Construction Name', 'Building Surface Name',
 'Outside Boundary Condition Object', 'View Factor to Ground',
 'Frame and Divider Name', 'Multiplier', 'Number of Vertices']
 + ["X,Y,Z ==> Vertex {n} (m)", ...]

# Shading:Building:Detailed  /  Shading:Site:Detailed
['Name', 'Transmittance Schedule Name', 'Number of Vertices']
 + ['X,Y,Z ==> Vertex {n} (m)', ...]
```

Note `'Space name'` in `BuildingSurface:Detailed` — a **recent** field. This is a concrete
example of why IDD-driven parsing (EPShape's approach) is mandatory rather than hardcoding
field positions.

Vertices are written `"  {x:.4f}, {y:.4f}, {z:.4f}"` — 4 decimal places, metres.

### ★ Surface pairing: VI-Suite does NOT solve this geometrically

`boundpoly()` in `envi_func.py` resolves `Outside Boundary Condition`. Critically, it
determines adjacency by reading **user-authored node-graph links**, not geometry:

```python
def boundpoly(obj, emnode, poly, enng):
    if emnode.envi_con_con == 'Zone':
        ...
        if insock.links:
            bobj  = bpy.data.objects[insock.links[0].from_node.zone]
            bpoly = bobj.data.polygons[int(...)]
            if emnode.ret_uv() != get_con_node(bmat.vi_params).ret_uv():
                logentry('U-values of the paired boundary surfaces ... do not match')
                return ('', '', '', '')
            else:
                return ("Surface", f'{...zone}_{bpoly.index}', "NoSun", "NoWind")
            if len(poly.vertices) != len(bpoly.vertices):
                logentry('... vertices do not match. Made adiabatic')
                return ("Adiabatic", "", "NoSun", "NoWind")
        else:
            return ("Adiabatic", "", "NoSun", "NoWind")
    elif emnode.envi_con_con == 'Thermal mass': return ("Adiabatic", "", "NoSun", "NoWind")
    elif emnode.envi_con_con == 'Ground':       return ("Ground",    "", "NoSun", "NoWind")
```

**The user wires the adjacency by hand.** Geometric auto-matching (the OpenStudio /
geomeppy `intersect_match` approach) is not implemented here. That means:

- Automatic geometric surface matching is a genuine **differentiator** for us, not a
  commodity feature.
- But it also means VI-Suite is *not* a reference implementation for it — look to OpenStudio
  and geomeppy (Shapely-based) for that algorithm instead.

Two validation behaviours worth stealing regardless:
- **U-value mismatch** between paired surfaces → warn, and let one construction take precedence.
- **Vertex-count mismatch** between paired surfaces → downgrade to `Adiabatic` rather than
  emitting a broken pair.

Also note the dead-code bug: the `len(poly.vertices) != len(bpoly.vertices)` check sits
*after* an unconditional `return`, so it never executes. Don't reproduce that ordering.

### Other techniques worth noting

- **Windows are written as two objects**: a `BuildingSurface:Detailed` acting as the frame
  (construction `{mat}-frame`, surface type `Wall`), plus a `FenestrationSurface:Detailed`
  inset from it by a percentage (`emnode.farea`) or by a fixed frame width (`emnode.fw`).
  Whether we adopt this is a modeling-philosophy question, but our *importer* must handle
  files that use it.
- **Hard limit enforced:** `if len(face.verts) > 4` for windows/doors → error. EnergyPlus
  restricts `FenestrationSurface:Detailed` to 3 or 4 vertices. Our validator must enforce this.
- **`ExpandObjects` is invoked** as a post-step (`ExpandObjects in.idf` → `expanded.idf`).
  Relevant if we ever want to resolve HVAC templates; not needed for geometry.
- Output is loaded back into Blender's text editor for inspection — a nice trust-building
  affordance. Consider showing a live IDF-text diff panel.

### Licensing — important

**VI-Suite is GPL v2.** Its exporter is a *reference* for field orders, ordering conventions,
and validation rules — all of which are facts about the IDF format, not copyrightable
expression. **Do not copy source code.** Read it, understand the algorithm, write our own.
Lifting code would force this project to GPL.

---

## Pascal Editor — `pascalorg/editor`

TypeScript, React 19, Next.js 16, React Three Fiber, three.js WebGPU renderer, Zustand +
Zundo, Zod, three-bvh-csg, Turborepo + Bun. MIT. ~21k stars.

**We are not building on it** (see `01-landscape.md` §Decision). But several architectural
patterns are worth borrowing outright, because they are good answers to problems we will hit.

### ★ Patterns to borrow

**1. Flat node dictionary, not a nested tree.**
Nodes live in a `Record<id, Node>` with hierarchy expressed via `parentId` and `children`
arrays — not nested objects. IDs are type-prefixed (`wall_abc123`).
*Why it matters for us:* IDF is inherently a flat list of named objects with
reference-by-name. A flat map is the natural fit, makes lookup O(1), keeps undo diffs small,
and avoids deep-clone problems. **Adopt directly.**

**2. Dirty-node + systems.**
Mutations flag a node dirty; a per-type "system" running inside the frame loop recomputes
geometry for dirty nodes and clears the flag. Flow: gesture → store update → node marked
dirty → system recomputes in `useFrame` → flag cleared.
*Why it matters for us:* retriangulating every surface on every edit will not scale to a
real model. Recompute only what changed. **Adopt the pattern, drop the React coupling.**

**3. Scene registry separate from the scene graph.**
A registry maps node IDs → `Object3D` instances, plus a `byType` index, so systems can find
objects without traversing the three.js scene graph.
*Why it matters for us:* picking and selection need document-ID ↔ mesh lookup in both
directions constantly. **Adopt.**

**4. Zundo for undo/redo.** Pascal gets 50-step undo by wrapping its Zustand store. This is
close to free and it is the right library. **Adopt.**

**5. Typed event bus (mitt).** Events like `wall:click`, `grid:click` carry the node, world
and local position, optional normal, and `stopPropagation`. **Adopt the payload shape** —
world + local + normal is exactly what surface editing needs.

**6. Declarative inspector.** `def.parametrics` describes properties; the host renders the
panel. Zero per-type UI code.
*Why it matters for us:* we already have per-version field-name arrays from the IDD. A
declarative inspector driven by that same table gives us a property editor for **every IDF
object class, for free** — including ones we do not render. Strong idea, directly applicable.

**7. Level display modes** — stacked / exploded / solo. Exploded-axonometric is genuinely
useful for inspecting multi-storey thermal zones. Cheap to implement, high review value.

### Patterns to avoid

- **Their domain model.** Site → Building → Level → Wall/Slab/Ceiling/Roof/Zone/Item is
  parametric-architectural. Ours must be surface-native. Do not try to mirror it.
- **WebGPU-only rendering.** Pascal is WebGPU-first. We should target WebGL2 for reach, and
  treat WebGPU as an optional upgrade. Check browser support before committing either way.
- **The full Next.js/Turborepo/Bun apparatus.** Overkill for a client-side tool that opens a
  file and draws polygons. EPShape's zero-build-step model is the opposite extreme; Vite sits
  sensibly between them.

### Their documented plugin-API rough edges (why we're not a plugin)

Taken from their own reference plugin's README:
- Plugin node types are not first-class — `createNode` and `floorPlaced.footprint` type
  against a hand-maintained `AnyNode` union, so plugin nodes need casts.
- `floor-placement` helpers "aren't part of the public `@pascal-app/*` surface yet."
- Instance matrices bake parent level world transforms and don't refresh on building move.
- Panels are explicitly *not* part of the v1 core plugin manifest.

---

## Summary: the three lessons that matter most

1. **From EPShape** — preprocess the IDD into a version-keyed field-name table. 25 KB solves
   EnergyPlus version drift permanently. Extend it past their five classes.
2. **From VI-Suite** — the exact field orders and validation rules for correct IDF output,
   plus the knowledge that geometric surface auto-matching is *unsolved* in the free tooling
   and is therefore our differentiator.
3. **From Pascal** — flat node dictionary, dirty-node recomputation, scene registry, Zundo,
   and a declarative inspector driven by the field table.
