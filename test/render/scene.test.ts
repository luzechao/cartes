/**
 * The scene layer — Layer 4 of docs/04-architecture.md.
 *
 * Everything asserted here runs headlessly, which is the point of keeping `WebGLRenderer`,
 * `OrbitControls` and raycasting confined to `viewer.ts`. A scene graph that can only be
 * checked by looking at it is a scene graph with no regression tests.
 *
 * The load-bearing assertions are the geometric ones — the Z-up → Y-up mapping, and the
 * fenestration offset's direction. Both are the kind of mistake that produces a picture: a
 * building lying on its side still renders, and a window sunk into its wall still renders,
 * flickering. Mutations tried, all killed:
 *
 *   S1  drop the root rotation                       → the axis-mapping test
 *   S2  rotate +90° instead of −90° about X          → same test; the model is upside down
 *   S3  offset fenestration along its own normal     → the reversed-window test
 *   S4  offset every surface by one step, not by depth → the nested-shading test
 *   S5  build edges from the triangulation, not the ring → the edge-segment-count test
 *   S6  make a new material per surface              → the sharing test
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Group, Mesh, Vector3, type BufferGeometry, type MeshLambertMaterial } from 'three'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model, type Vec3 } from '../../src/model/index.js'
import { resolveModel, type ResolvedSurface } from '../../src/geometry/index.js'
import {
  buildScene,
  constructionColor,
  FENESTRATION_OFFSET,
  hoverInfo,
  SceneRegistry,
  SURFACE_TYPE_COLORS,
  surfaceEdgePositions,
  surfaceGeometry,
  Z_UP_TO_Y_UP,
  type SceneBuild,
  type SceneEntry,
} from '../../src/render/index.js'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'known-answer')
const CORPUS = join(import.meta.dirname, '..', 'fixtures', 'testfiles')

interface Loaded {
  model: Model
  resolved: Map<string, ResolvedSurface>
  build: SceneBuild
  /** Scene entries by surface name, since ids are positional and names are what the file says. */
  byName: Map<string, SceneEntry>
  /** Resolved geometry by surface name. */
  geoByName: Map<string, ResolvedSurface>
}

function assemble(source: string): Loaded {
  const model = buildModel(parseIdf(source))
  const resolved = resolveModel(model)
  const build = buildScene(model, resolved)
  const byName = new Map<string, SceneEntry>()
  const geoByName = new Map<string, ResolvedSurface>()
  for (const entry of build.registry) {
    byName.set(entry.name, entry)
    geoByName.set(entry.name, resolved.get(entry.id)!)
  }
  return { model, resolved, build, byName, geoByName }
}

function load(name: string): Loaded {
  return assemble(readFileSync(join(FIXTURES, name), 'utf8'))
}

function positionsOf(mesh: Mesh): Vec3[] {
  const attr = (mesh.geometry as BufferGeometry).getAttribute('position')
  const out: Vec3[] = []
  for (let i = 0; i < attr.count; i++) {
    out.push({ x: attr.getX(i), y: attr.getY(i), z: attr.getZ(i) })
  }
  return out
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function colorOf(entry: SceneEntry): number {
  return (entry.mesh.material as MeshLambertMaterial).color.getHex()
}

// ---------------------------------------------------------------------------
// A minimal file with a deliberately mis-wound window
// ---------------------------------------------------------------------------

/**
 * One wall, one window whose vertices run the *other way round*, and an overhang attached to
 * that window rather than to the wall.
 *
 * Both anomalies are real. Files come out of translators and hand edits with fenestration
 * wound against its base surface, and `Shading:Zone:Detailed` naming a window is explicitly
 * allowed — EnergyPlus resolves the shading's zone through it. Together they are the case
 * where "nudge each surface along its own normal, one step" produces a window buried in its
 * wall and an overhang buried in the window.
 */
const REVERSED_WINDOW = `
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed,
  WALL, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0, 3;
FenestrationSurface:Detailed,
  WIN, Window, Glazing, WALL, , , , 1, 4,
  3.5, 0, 2.5,
  3.5, 0, 0.5,
  0.5, 0, 0.5,
  0.5, 0, 2.5;
Shading:Zone:Detailed,
  FIN, WIN, , 4,
  0.5, 0, 2.5,
  0.5, 0, 3.0,
  3.5, 0, 3.0,
  3.5, 0, 2.5;
`

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

describe('surfaceGeometry', () => {
  const { geoByName } = load('gate-world.idf')
  const floor = geoByName.get('FLOOR')!

  it('writes the resolved world vertices, unmodified, when there is no offset', () => {
    const positions = positionsOf(new Mesh(surfaceGeometry(floor)))
    expect(positions.length).toBe(floor.worldVertices.length)
    positions.forEach((p, i) => {
      const w = floor.worldVertices[i]!
      expect(p.x, `v${i} x`).toBeCloseTo(w.x, 5)
      expect(p.y, `v${i} y`).toBeCloseTo(w.y, 5)
      expect(p.z, `v${i} z`).toBeCloseTo(w.z, 5)
    })
  })

  /**
   * One normal for the whole polygon, and it is Newell's, not a per-vertex average. For the
   * slightly non-planar surfaces real files contain those two differ, and Newell's is the
   * best-fit plane — the same plane EnergyPlus itself uses.
   */
  it('gives every vertex the surface normal, so the surface shades flat', () => {
    const attr = surfaceGeometry(floor).getAttribute('normal')
    for (let i = 0; i < attr.count; i++) {
      expect(attr.getX(i), `v${i}`).toBeCloseTo(floor.normal.x, 6)
      expect(attr.getY(i), `v${i}`).toBeCloseTo(floor.normal.y, 6)
      expect(attr.getZ(i), `v${i}`).toBeCloseTo(floor.normal.z, 6)
    }
  })

  /**
   * 16-bit indices top out at 65 535 vertices. A single surface never comes close, but the
   * type has to be pinned somewhere: three picks the index type from the array it is handed,
   * so a `Uint16Array` here would work on every test file and quietly truncate on the one
   * pathological facade someone exports from Rhino.
   */
  it('indexes with the triangulation, as 32-bit indices', () => {
    const index = surfaceGeometry(floor).getIndex()!
    expect(index.array).toBeInstanceOf(Uint32Array)
    expect([...index.array]).toEqual([...floor.triangles])
  })

  it('displaces along the direction given, by exactly the offset', () => {
    const direction: Vec3 = { x: 0, y: 0, z: 1 }
    const moved = positionsOf(new Mesh(surfaceGeometry(floor, 0.25, direction)))
    moved.forEach((p, i) => {
      const w = floor.worldVertices[i]!
      expect(p.z - w.z, `v${i}`).toBeCloseTo(0.25, 5)
      expect(p.x - w.x, `v${i}`).toBeCloseTo(0, 5)
    })
  })
})

describe('surfaceEdgePositions', () => {
  const { geoByName } = load('gate-world.idf')
  const floor = geoByName.get('FLOOR')!

  /**
   * The outline is the polygon ring, not the triangulation. A 4-gon has 4 edges and 2
   * triangles; drawing the triangles' edges would put a diagonal across every wall, and
   * across every concave floor a whole web of them. This is the difference between a drawing
   * of a building and a drawing of a mesh.
   */
  it('emits one segment per polygon edge, closing the ring', () => {
    const flat = surfaceEdgePositions(floor)
    const n = floor.worldVertices.length
    expect(flat.length).toBe(n * 6)

    for (let i = 0; i < n; i++) {
      const a = floor.worldVertices[i]!
      const b = floor.worldVertices[(i + 1) % n]!
      expect([flat[i * 6], flat[i * 6 + 1], flat[i * 6 + 2]], `segment ${i} start`).toEqual([
        a.x,
        a.y,
        a.z,
      ])
      expect([flat[i * 6 + 3], flat[i * 6 + 4], flat[i * 6 + 5]], `segment ${i} end`).toEqual([
        b.x,
        b.y,
        b.z,
      ])
    }
  })

  it('takes the same offset as the fill, so the outline stays on its surface', () => {
    const direction: Vec3 = { x: 0, y: 0, z: 1 }
    const flat = surfaceEdgePositions(floor, 0.25, direction)
    for (let i = 2; i < flat.length; i += 3) {
      expect(flat[i]! - floor.worldVertices[0]!.z).toBeCloseTo(0.25, 5)
    }
  })

  it('draws nothing for a surface with fewer than two vertices', () => {
    expect(surfaceEdgePositions({ ...floor, worldVertices: [] })).toEqual([])
    expect(surfaceEdgePositions({ ...floor, worldVertices: [{ x: 1, y: 2, z: 3 }] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('SceneRegistry', () => {
  const { build, byName } = load('gate-world.idf')

  it('holds one entry per drawn surface, in document order', () => {
    expect([...build.registry].map((e) => e.name)).toEqual([
      'FLOOR',
      'WALL SOUTH',
      'WINDOW SOUTH',
      'OVERHANG SOUTH',
      'CARPORT',
      'NEIGHBOUR',
    ])
    expect(build.registry.size).toBe(6)
    expect(build.skipped).toEqual([])
  })

  /**
   * A raycast reports the leaf it struck, which may one day be a child of the mesh — a normal
   * arrow, a selection outline. Walking the parent chain means picking keeps working when
   * that happens instead of silently returning nothing.
   */
  it('maps an object back to its surface, through the parent chain', () => {
    const wall = byName.get('WALL SOUTH')!
    expect(build.registry.idOfObject(wall.mesh)).toBe(wall.id)
    expect(build.registry.idOfObject(wall.edges)).toBe(wall.id)

    const decoration = new Group()
    wall.mesh.add(decoration)
    expect(build.registry.idOfObject(decoration)).toBe(wall.id)
  })

  it('stops at the scene root rather than claiming it', () => {
    expect(build.registry.idOfObject(build.root)).toBeUndefined()
    expect(build.registry.idOfObject(null)).toBeUndefined()
    expect(build.registry.idOfObject(new Mesh())).toBeUndefined()
  })

  /**
   * The indices exist so that "hide this zone" and "recolour every window" are one lookup
   * rather than a walk over 8000 objects.
   */
  it('indexes by category and by zone without traversing the graph', () => {
    const windows = build.registry.byCategory('window')
    expect(windows.map((id) => build.registry.get(id)!.name)).toEqual(['WINDOW SOUTH'])
    expect(build.registry.byCategory('wall').length).toBe(1)
    expect(build.registry.byCategory('door')).toEqual([])

    const zoneId = byName.get('FLOOR')!.zoneId!
    expect(build.registry.byZone(zoneId).map((id) => build.registry.get(id)!.name)).toEqual([
      'FLOOR',
      'WALL SOUTH',
      'WINDOW SOUTH',
      'OVERHANG SOUTH',
    ])
    expect(build.registry.byZone('nope')).toEqual([])
  })

  it('releases geometries and empties itself on dispose', () => {
    const local = load('gate-world.idf')
    const geometries = [...local.build.registry].map((e) => e.mesh.geometry)
    let disposed = 0
    for (const g of geometries) g.addEventListener('dispose', () => disposed++)

    local.build.registry.dispose()
    expect(disposed).toBe(geometries.length)
    expect(local.build.registry.size).toBe(0)
    expect(local.build.root.children.length).toBe(0)
    expect(local.build.registry.idOfObject(local.byName.get('FLOOR')!.mesh)).toBeUndefined()
  })

  it('reports nothing for an empty registry rather than throwing', () => {
    const empty = new SceneRegistry()
    expect(empty.size).toBe(0)
    expect(empty.get('anything')).toBeUndefined()
    expect(empty.byCategory('wall')).toEqual([])
    expect([...empty]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The scene graph
// ---------------------------------------------------------------------------

describe('buildScene', () => {
  const loaded = load('gate-world.idf')
  const { build, byName, geoByName } = loaded

  it('gives each surface a group holding its fill and its outline', () => {
    for (const entry of build.registry) {
      expect(entry.object.parent, entry.name).toBe(build.root)
      expect(entry.object.children, entry.name).toContain(entry.mesh)
      expect(entry.object.children, entry.name).toContain(entry.edges)
      expect(entry.mesh.userData['surfaceId'], entry.name).toBe(entry.id)
    }
  })

  /**
   * The single coordinate conversion, checked as a conversion rather than as a number.
   *
   * EnergyPlus is Z-up, three.js is Y-up, and every vertex in this codebase stays in the
   * EnergyPlus frame — so the root rotation is the *only* thing standing between the two
   * (docs/03-idf-geometry.md §Units and axes). Assert the mapping it produces, not the
   * `rotation.x` value: E+ (x, y, z) must be drawn at three (x, z, −y), and a +90° rotation
   * gives (x, −z, y), which is the same building upside down and passes any test that only
   * checks the angle's magnitude.
   */
  it('maps EnergyPlus Z-up to three.js Y-up, once, on the root', () => {
    expect(build.root.rotation.x).toBeCloseTo(Z_UP_TO_Y_UP, 12)
    build.root.updateMatrixWorld(true)

    for (const entry of build.registry) {
      // Nothing between the root and the mesh may transform: one conversion, not two.
      expect(entry.object.position.lengthSq(), entry.name).toBe(0)
      expect(entry.object.rotation.x + entry.object.rotation.y + entry.object.rotation.z).toBe(0)

      const eplus = geoByName.get(entry.name)!.worldVertices[0]!
      const drawn = new Vector3(eplus.x, eplus.y, eplus.z).applyMatrix4(entry.mesh.matrixWorld)
      expect(drawn.x, `${entry.name} x`).toBeCloseTo(eplus.x, 6)
      expect(drawn.y, `${entry.name} y`).toBeCloseTo(eplus.z, 6)
      expect(drawn.z, `${entry.name} z`).toBeCloseTo(-eplus.y, 6)
    }
  })

  it('carries the hover metadata: name, construction, zone', () => {
    const window = byName.get('WINDOW SOUTH')!
    expect(window.className).toBe('FenestrationSurface:Detailed')
    expect(window.constructionName).toBe('Generic Window')
    expect(window.zoneName).toBe('ZONE ONE')
    expect(window.category).toBe('window')

    const neighbour = byName.get('NEIGHBOUR')!
    expect(neighbour.category).toBe('shading')
    expect(neighbour.constructionName).toBe('')
    expect(neighbour.zoneId).toBeUndefined()
    expect(neighbour.zoneName).toBeUndefined()
  })

  it('renders the hover readout, with an em dash where there is no value', () => {
    const at = new Vector3(1, 2, 3)
    expect(hoverInfo(byName.get('WINDOW SOUTH')!, at)).toMatchObject({
      name: 'WINDOW SOUTH',
      construction: 'Generic Window',
      zone: 'ZONE ONE',
    })
    expect(hoverInfo(byName.get('NEIGHBOUR')!, at)).toMatchObject({
      name: 'NEIGHBOUR',
      construction: '—',
      zone: '—',
    })
  })

  /**
   * Windows and their attached shading sit exactly on the wall, which is a depth-buffer tie
   * the GPU breaks differently every frame — the surface flickers as the camera moves. v1
   * nudges rather than doing CSG (docs/03-idf-geometry.md §Triangulation).
   */
  it('lifts fenestration off its base surface, and leaves the base surface alone', () => {
    const wall = byName.get('WALL SOUTH')!
    const wallGeo = geoByName.get('WALL SOUTH')!
    positionsOf(wall.mesh).forEach((p, i) => {
      expect(sub(p, wallGeo.worldVertices[i]!), `wall v${i}`).toEqual({ x: 0, y: 0, z: 0 })
    })

    for (const name of ['WINDOW SOUTH', 'OVERHANG SOUTH']) {
      const geo = geoByName.get(name)!
      positionsOf(byName.get(name)!.mesh).forEach((p, i) => {
        const delta = sub(p, geo.worldVertices[i]!)
        expect(dot(delta, wallGeo.normal), `${name} v${i} outward`).toBeCloseTo(
          FENESTRATION_OFFSET,
          6,
        )
      })
    }
  })
})

describe('the fenestration nudge, on a mis-wound window', () => {
  const { byName, geoByName } = assemble(REVERSED_WINDOW)
  const wallNormal = geoByName.get('WALL')!.normal
  const windowNormal = geoByName.get('WIN')!.normal

  it('is set up as intended: the window really is wound against its wall', () => {
    // The premise of the next two tests. Reversing a polygon reverses its Newell normal, so
    // this is a fact about the fixture, not about the resolver.
    expect(dot(windowNormal, wallNormal)).toBeCloseTo(-1, 9)
  })

  /**
   * Following each surface's own normal is the obvious implementation and it is wrong here:
   * the window's normal points into the wall, so the nudge would push it further in and make
   * the flicker worse. The family is anchored to its base surface instead.
   */
  it('pushes the window outward along the wall, not inward along itself', () => {
    const geo = geoByName.get('WIN')!
    positionsOf(byName.get('WIN')!.mesh).forEach((p, i) => {
      const delta = sub(p, geo.worldVertices[i]!)
      expect(dot(delta, wallNormal), `v${i}`).toBeCloseTo(FENESTRATION_OFFSET, 9)
    })
  })

  /**
   * A `Shading:Zone:Detailed` may name a window as its base surface. It has to clear the
   * window, which has already cleared the wall — so one flat offset for everything leaves the
   * fin and the window fighting each other instead of the wall.
   */
  it('gives shading attached to that window a second step, in the same direction', () => {
    const geo = geoByName.get('FIN')!
    positionsOf(byName.get('FIN')!.mesh).forEach((p, i) => {
      const delta = sub(p, geo.worldVertices[i]!)
      expect(dot(delta, wallNormal), `v${i}`).toBeCloseTo(2 * FENESTRATION_OFFSET, 9)
    })
  })

  it('can be switched off entirely', () => {
    const model = buildModel(parseIdf(REVERSED_WINDOW))
    const resolved = resolveModel(model)
    const flat = buildScene(model, resolved, { fenestrationOffset: 0 })
    for (const entry of flat.registry) {
      const geo = resolved.get(entry.id)!
      positionsOf(entry.mesh).forEach((p, i) => {
        expect(sub(p, geo.worldVertices[i]!), `${entry.name} v${i}`).toEqual({ x: 0, y: 0, z: 0 })
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

describe('colour modes', () => {
  it('colours by surface type by default', () => {
    const { byName } = load('gate-world.idf')
    expect(colorOf(byName.get('WALL SOUTH')!)).toBe(SURFACE_TYPE_COLORS.wall)
    expect(colorOf(byName.get('FLOOR')!)).toBe(SURFACE_TYPE_COLORS.floor)
    expect(colorOf(byName.get('WINDOW SOUTH')!)).toBe(SURFACE_TYPE_COLORS.window)
    expect(colorOf(byName.get('CARPORT')!)).toBe(SURFACE_TYPE_COLORS.shading)
  })

  it('colours by construction on request, leaving shading on its own colour', () => {
    const model = buildModel(parseIdf(readFileSync(join(FIXTURES, 'gate-world.idf'), 'utf8')))
    const build = buildScene(model, resolveModel(model), { colorBy: 'construction' })
    const byName = new Map([...build.registry].map((e) => [e.name, e] as const))

    expect(colorOf(byName.get('WALL SOUTH')!)).toBe(constructionColor('Generic Wall'))
    expect(colorOf(byName.get('FLOOR')!)).toBe(constructionColor('Generic Wall'))
    expect(colorOf(byName.get('WINDOW SOUTH')!)).toBe(constructionColor('Generic Window'))
    // Shading has no construction; hashing its blank name would paint it magenta.
    expect(colorOf(byName.get('CARPORT')!)).toBe(SURFACE_TYPE_COLORS.shading)
  })

  /**
   * A material per surface would be tens of thousands of them on a real model, each its own
   * shader program and draw-call state change, for a picture identical to the shared one.
   */
  it('shares one material across every surface of a colour', () => {
    const { byName } = load('gate-world.idf')
    expect(byName.get('CARPORT')!.mesh.material).toBe(byName.get('NEIGHBOUR')!.mesh.material)
    expect(byName.get('WALL SOUTH')!.mesh.material).not.toBe(byName.get('FLOOR')!.mesh.material)
  })

  /** Glass is translucent so the room behind it stays readable; a wall is not. */
  it('makes glazing translucent and everything else opaque', () => {
    const { byName } = load('gate-world.idf')
    const glass = byName.get('WINDOW SOUTH')!.mesh.material as MeshLambertMaterial
    expect(glass.transparent).toBe(true)
    expect(glass.opacity).toBeLessThan(1)

    const wall = byName.get('WALL SOUTH')!.mesh.material as MeshLambertMaterial
    expect(wall.transparent).toBe(false)
    expect(wall.opacity).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Files that are not clean
// ---------------------------------------------------------------------------

describe('degenerate input', () => {
  /**
   * A surface with fewer than two vertices has no outline and no fill, so there is nothing to
   * draw. It still has to be *accounted for*: silently dropping surfaces is how a file comes
   * to look emptier than it is, which is the failure mode `Model.unrendered` exists to
   * prevent for Tier 3 classes.
   */
  it('skips a surface with nothing to draw, and says which', () => {
    const { model, build } = assemble(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed,
  STUB, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 1,
  0, 0, 0;
BuildingSurface:Detailed,
  REAL, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0, 3;
`)
    expect(build.skipped.map((id) => model.surfaces.get(id)!.name)).toEqual(['STUB'])
    expect([...build.registry].map((e) => e.name)).toEqual(['REAL'])
  })

  /**
   * Three collinear "corners": a real thing in real files. It triangulates to nothing, but it
   * still has an outline, and drawing that line is more honest than pretending the object is
   * not in the file.
   */
  it('draws the outline of a collinear surface even though it has no triangles', () => {
    const { build, byName, geoByName } = assemble(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed,
  FLAT, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 3,
  0, 0, 0,
  1, 0, 0,
  2, 0, 0;
`)
    expect(build.skipped).toEqual([])
    expect(geoByName.get('FLAT')!.triangles.length).toBe(0)

    const entry = byName.get('FLAT')!
    expect(entry.mesh.geometry.getIndex()!.count).toBe(0)
    for (const p of positionsOf(entry.mesh)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
    }
  })

  it('draws a file with no zones at all — detached shading is a valid model', () => {
    const { build } = assemble(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Shading:Site:Detailed,
  TREE, , 4,
  0, 0, 0,
  2, 0, 0,
  2, 0, 3,
  0, 0, 3;
`)
    expect(build.registry.size).toBe(1)
    expect([...build.registry][0]!.zoneId).toBeUndefined()
  })
})

/**
 * Tripwire, not a specification.
 *
 * Measured over the 126-file corpus: 116 files draw completely, 3 draw *nothing* — and zero
 * files draw partially. A file that uses EnergyPlus's simplified rectangular classes uses
 * them exclusively. That makes "N objects not drawn" the whole story on those files rather
 * than a footnote, which is why the shell states it on the stage instead of in the footer.
 *
 * When Tier-3 vertex derivation lands, this test fails. That is its job: it forces the
 * empty-state copy in `src/ui/App.tsx` to be revisited in the same change.
 */
describe('all-Tier-3 files', () => {
  const ALL_TIER3 = [
    '4ZoneWithShading_Simple_1.idf',
    '4ZoneWithShading_Simple_2.idf',
    'HybridModel_4Zone_Solve_Infiltration_free_floating.idf',
  ]

  for (const name of ALL_TIER3) {
    it(`${name} has geometry to report but none to draw`, () => {
      const model = buildModel(parseIdf(readFileSync(join(CORPUS, name), 'utf8')))
      const build = buildScene(model, resolveModel(model))

      expect(build.registry.size).toBe(0)
      expect(build.skipped).toEqual([])
      // The surfaces are not lost, only undrawn — the banner has something to say.
      const unrendered = [...model.unrendered.values()].reduce((a, b) => a + b, 0)
      expect(unrendered).toBeGreaterThan(0)
      // ...and the file is otherwise sound, so an empty stage cannot be blamed on a parse error.
      expect(model.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    })
  }
})
