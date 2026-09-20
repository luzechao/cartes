import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, renderObject } from '../../src/parser/index.js'
import type { IdfDocument } from '../../src/parser/index.js'
import { buildModel, getSchema, vertexLayout, type Model } from '../../src/model/index.js'
import type { CoordinateSystem, Zone } from '../../src/model/index.js'
import { resolveModel, newellNormal, orderVertices, validateModel, type ResolvedSurface } from '../../src/geometry/index.js'

/**
 * PHASE 2 GATE (docs/05-implementation-plan.md)
 *
 *   Resolved world vertices for a Relative-coordinate fixture match those for the equivalent
 *   World-coordinate file, within 1e-6 m. Round-trip from Phase 1 still byte-identical.
 *
 * The *independent* half of that gate lives in resolve.test.ts, where a hand-authored
 * Relative/World pair is checked against coordinates derived by hand. This file is the
 * breadth half, and it works two ways:
 *
 *   1. Rewrite each Relative file into its World equivalent and check the two resolve alike.
 *      The expected values come from our own resolver, so this is a self-consistency check:
 *      it catches the two branches disagreeing — a class handled in one and forgotten in the
 *      other, an origin applied where it should not be — but it is blind to an error made
 *      identically in both, and blind to any Relative-branch error whose World counterpart
 *      is the identity.
 *
 *   2. Check invariants that follow from the spec rather than from the code: the transform
 *      is a rigid motion, it translates z by exactly the zone origin, and it turns every
 *      surface's normal clockwise by exactly the sum of the angles that apply to it.
 *
 * Those invariants only bite where the corpus supplies a nonzero angle, and it mostly does
 * not. Measured over the 182 files here: no file carries an Appendix G rotation, the one
 * Relative file with detached building shading has North Axis 0, and exactly one file has a
 * nonzero Direction of Relative North — 180 deg, whose sine is zero. So on the corpus as
 * written, a transposed sine and a building-shading rotation taken from the wrong angle are
 * both invisible; both mutations were tried and both survived.
 *
 * Hence the third pass: re-resolve every file with angles injected into the model, which
 * puts real geometry through rotations the corpus never exercises. The hand-derived
 * fixtures in resolve.test.ts anchor the sign convention on six surfaces; this extends that
 * anchor over 8000.
 *
 * The corpus is gitignored (see .gitignore); these tests no-op without it.
 */

const FIXTURES = join(import.meta.dirname, '..', 'fixtures')
const BULK_DIR = join(FIXTURES, 'testfiles')
const VERSIONS_DIR = join(FIXTURES, 'versions')

interface Fixture {
  label: string
  path: string
}

function listCorpus(): Fixture[] {
  const out: Fixture[] = []
  if (existsSync(BULK_DIR)) {
    for (const f of readdirSync(BULK_DIR).filter((x) => x.endsWith('.idf')).sort()) {
      out.push({ label: f, path: join(BULK_DIR, f) })
    }
  }
  if (existsSync(VERSIONS_DIR)) {
    for (const dir of readdirSync(VERSIONS_DIR).sort()) {
      const full = join(VERSIONS_DIR, dir)
      for (const f of readdirSync(full).filter((x) => x.endsWith('.idf')).sort()) {
        out.push({ label: `${dir}/${f}`, path: join(full, f) })
      }
    }
  }
  return out
}

const corpus = listCorpus()

function load(path: string): { doc: IdfDocument; model: Model; resolved: Map<string, ResolvedSurface> } {
  const doc = parseIdf(readFileSync(path, 'utf8'))
  const model = buildModel(doc)
  return { doc, model, resolved: resolveModel(model) }
}

/**
 * Rewrite a Relative-coordinate document into its World-coordinate equivalent, by writing
 * each surface's resolved vertices back into its vertex fields and flipping
 * `GlobalGeometryRules`.
 *
 * Vertex *order* is left alone deliberately. The rewritten file keeps the original's
 * Starting Vertex Position and Vertex Entry Direction, so reordering runs identically on
 * both sides and the comparison isolates the coordinate transform.
 *
 * The zone origins, Direction of Relative North and Building North Axis are all left in
 * place, because a correct World resolver must ignore them. Appendix G is the exception: it
 * applies in both coordinate systems, so it stays meaningful and is zeroed instead.
 */
function toWorldDocument(model: Model, resolved: Map<string, ResolvedSurface>): string {
  const doc = model.doc
  for (const [id, r] of resolved) {
    const obj = doc.objects.get(id)
    const surface = model.surfaces.get(id)
    if (!obj || !surface) continue
    const schema = getSchema(obj.classKey, model.version)
    if (!schema) continue
    const layout = vertexLayout(schema)
    if (!layout) continue

    // Undo the reorder so field n still holds the file's nth vertex.
    const bySource = new Array<{ x: number; y: number; z: number }>(r.worldVertices.length)
    r.sourceIndex.forEach((src, i) => {
      bySource[src] = r.worldVertices[i]!
    })

    bySource.forEach((v, i) => {
      const base = layout.beginIndex + i * layout.stride
      const set = (k: number, value: number): void => {
        const field = obj.fields[k]
        if (field) field.value = String(value)
      }
      set(base, v.x)
      set(base + 1, v.y)
      set(base + 2, v.z)
    })
    obj.dirty = true
  }

  const rulesId = model.rules.id
  if (rulesId !== undefined) {
    const obj = doc.objects.get(rulesId)
    const schema = getSchema('globalgeometryrules', model.version)
    if (obj && schema) {
      const i = schema.index.get('coordinate system')
      if (i !== undefined && obj.fields[i]) obj.fields[i].value = 'World'
      obj.dirty = true
    }
  }

  const complianceId = model.site.complianceId
  if (complianceId !== undefined) {
    const obj = doc.objects.get(complianceId)
    if (obj && obj.fields[0]) {
      obj.fields[0].value = '0'
      obj.dirty = true
    }
  }

  // Touch renderObject so a broken emitter surfaces here rather than as a mystery diff.
  void renderObject
  return emitIdf(doc)
}

function maxDeviation(a: ResolvedSurface, b: ResolvedSurface): number {
  if (a.worldVertices.length !== b.worldVertices.length) return Infinity
  let worst = 0
  a.worldVertices.forEach((va, i) => {
    const vb = b.worldVertices[i]!
    worst = Math.max(worst, Math.abs(va.x - vb.x), Math.abs(va.y - vb.y), Math.abs(va.z - vb.z))
  })
  return worst
}

// ---------------------------------------------------------------------------
// Spec invariants — independent of how the transform is implemented
// ---------------------------------------------------------------------------

/**
 * The total clockwise rotation that applies to a surface, in degrees.
 *
 * Straight from docs/03-idf-geometry.md, not from the resolver: in Relative coordinates a
 * zone surface turns by its zone's relative north plus the building's north axis plus
 * Appendix G; detached building shading skips the zone term; detached site shading is
 * exempt. In World coordinates only Appendix G survives, and site shading is still exempt.
 */
function expectedRotation(model: Model, id: string): number {
  const surface = model.surfaces.get(id)!
  const isSiteShading = surface.kind === 'shading' && surface.shadingKind === 'site'
  if (isSiteShading) return 0
  if (model.rules.coordinateSystem === 'World') return model.site.appendixGRotation

  const building = model.site.northAxis + model.site.appendixGRotation
  const zoneId = model.zoneOf.get(id)
  const zone = zoneId === undefined ? undefined : model.zones.get(zoneId)
  return zone ? zone.directionOfRelativeNorth + building : building
}

/** Signed angle from a to b about +z, in degrees, wrapped to (-180, 180]. */
function azimuthDelta(a: { x: number; y: number }, b: { x: number; y: number }): number {
  let d = (Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x)) * (180 / Math.PI)
  while (d <= -180) d += 360
  while (d > 180) d -= 360
  return d
}

/**
 * Every surface's normal must turn clockwise about +z by exactly `expectedRotation`, and by
 * nothing else. Horizontal surfaces are skipped — a normal along ±z has no azimuth.
 */
function checkNormalRotation(
  label: string,
  model: Model,
  resolved: Map<string, ResolvedSurface>,
  failures: string[],
): { checked: number; withRotation: number } {
  let checked = 0
  let withRotation = 0
  for (const [id, r] of resolved) {
    const surface = model.surfaces.get(id)!
    // Reorder but do not transform, so the two normals differ only by the rotation.
    const local = newellNormal(
      orderVertices(
        surface.vertices,
        model.rules.startingVertexPosition,
        model.rules.vertexEntryDirection,
      ).vertices,
    )
    if (Math.hypot(local.x, local.y) < 0.1) continue
    if (Math.hypot(r.normal.x, r.normal.y) < 0.1) continue

    const want = expectedRotation(model, id)
    // Clockwise by `want` means the azimuth decreases by `want`.
    let expectedDelta = ((-want % 360) + 360) % 360
    if (expectedDelta > 180) expectedDelta -= 360
    const actual = azimuthDelta(local, r.normal)
    let err = Math.abs(actual - expectedDelta)
    if (err > 180) err = 360 - err

    checked++
    if (want % 360 !== 0) withRotation++
    if (err > 1e-6) {
      failures.push(
        `${label}: ${surface.name} turned ${actual.toFixed(6)} deg, expected ${expectedDelta.toFixed(6)}`,
      )
    }
  }
  return { checked, withRotation }
}

/** Rotation and translation preserve distance; scaling, shearing and reflection do not. */
function checkRigidMotion(
  label: string,
  model: Model,
  resolved: Map<string, ResolvedSurface>,
  failures: string[],
): void {
  for (const [id, r] of resolved) {
    const surface = model.surfaces.get(id)!
    const local = r.sourceIndex.map((i) => surface.vertices[i]!)
    for (let i = 0; i < local.length; i++) {
      const j = (i + 1) % local.length
      const a = local[i]!
      const b = local[j]!
      const wa = r.worldVertices[i]!
      const wb = r.worldVertices[j]!
      const before = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
      const after = Math.hypot(wa.x - wb.x, wa.y - wb.y, wa.z - wb.z)
      if (Math.abs(before - after) > 1e-9) {
        failures.push(`${label}: ${surface.name} edge ${i + 1} went ${before} -> ${after}`)
      }
    }
  }
}

/**
 * All rotation is about the vertical axis, so z moves only by the zone origin — and only for
 * zone surfaces in Relative coordinates. Detached shading keeps z exactly.
 */
function checkZTranslation(
  label: string,
  model: Model,
  resolved: Map<string, ResolvedSurface>,
  failures: string[],
): number {
  let checked = 0
  for (const [id, r] of resolved) {
    const surface = model.surfaces.get(id)!
    const zoneId = model.zoneOf.get(id)
    const zone = zoneId === undefined ? undefined : model.zones.get(zoneId)
    const dz = model.rules.coordinateSystem === 'Relative' && zone ? zone.origin.z : 0
    r.worldVertices.forEach((v, i) => {
      const src = surface.vertices[r.sourceIndex[i]!]!
      if (Math.abs(v.z - (src.z + dz)) > 1e-9) {
        failures.push(`${label}: ${surface.name} z ${src.z} + ${dz} != ${v.z}`)
      }
    })
    checked++
  }
  return checked
}

describe.skipIf(corpus.length === 0)(`Phase 2 gate over ${corpus.length} corpus files`, () => {
  it('resolves every surface to finite coordinates', () => {
    const bad: string[] = []
    let surfaces = 0
    let vertices = 0
    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      for (const [id, r] of resolved) {
        surfaces++
        vertices += r.worldVertices.length
        const finite = r.worldVertices.every(
          (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
        )
        if (!finite || !Number.isFinite(r.area) || !Number.isFinite(r.planarityError)) {
          bad.push(`${label}: ${model.surfaces.get(id)?.name ?? id}`)
        }
      }
    }
    expect(surfaces).toBeGreaterThan(1000)
    expect(vertices).toBeGreaterThan(4000)
    expect(bad).toEqual([])
  })

  it('agrees between Relative and its World rewrite, within 1e-6 m', () => {
    const failures: string[] = []
    let compared = 0
    let relativeFiles = 0

    for (const { label, path } of corpus) {
      const before = load(path)
      if (before.model.rules.coordinateSystem !== 'Relative') continue
      relativeFiles++

      const worldSource = toWorldDocument(before.model, before.resolved)
      const after = load(path) // re-read: toWorldDocument mutated the first document
      const worldModel = buildModel(parseIdf(worldSource))
      const worldResolved = resolveModel(worldModel)

      expect(worldModel.rules.coordinateSystem, label).toBe('World')

      for (const [id, r] of after.resolved) {
        const surface = after.model.surfaces.get(id)!
        const worldId = worldModel.names.byClass.get(surface.classKey)?.get(surface.name.toLowerCase())
        const w = worldId === undefined ? undefined : worldResolved.get(worldId)
        if (!w) {
          failures.push(`${label}: ${surface.className} '${surface.name}' missing after rewrite`)
          continue
        }
        compared++
        const dev = maxDeviation(r, w)
        if (!(dev <= 1e-6)) failures.push(`${label}: ${surface.name} deviates ${dev.toExponential(3)} m`)
      }
    }

    expect(relativeFiles).toBeGreaterThan(0)
    expect(compared).toBeGreaterThan(500)
    expect(failures.slice(0, 20)).toEqual([])
  })

  it('leaves World files without an Appendix G rotation exactly as written', () => {
    let checked = 0
    const failures: string[] = []
    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      if (model.rules.coordinateSystem !== 'World') continue
      if (model.site.appendixGRotation !== 0) continue
      for (const [id, r] of resolved) {
        const surface = model.surfaces.get(id)!
        r.worldVertices.forEach((v, i) => {
          const src = surface.vertices[r.sourceIndex[i]!]!
          if (v.x !== src.x || v.y !== src.y || v.z !== src.z) {
            failures.push(`${label}: ${surface.name} vertex ${i + 1} moved`)
          }
        })
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(failures.slice(0, 20)).toEqual([])
  })

  it('leaves Relative files with no origins and no rotations exactly as written', () => {
    // The other identity case, and the one that catches a transform applied to the wrong
    // axis: it holds regardless of how the rotation matrices are built.
    let checked = 0
    const failures: string[] = []
    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      if (model.rules.coordinateSystem !== 'Relative') continue
      if (model.site.northAxis !== 0 || model.site.appendixGRotation !== 0) continue
      const trivial = [...model.zones.values()].every(
        (z) =>
          z.directionOfRelativeNorth === 0 &&
          z.origin.x === 0 &&
          z.origin.y === 0 &&
          z.origin.z === 0,
      )
      if (!trivial || model.zones.size === 0) continue
      for (const [id, r] of resolved) {
        const surface = model.surfaces.get(id)!
        r.worldVertices.forEach((v, i) => {
          const src = surface.vertices[r.sourceIndex[i]!]!
          if (v.x !== src.x || v.y !== src.y || v.z !== src.z) {
            failures.push(`${label}: ${surface.name} vertex ${i + 1} moved`)
          }
        })
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(failures.slice(0, 20)).toEqual([])
  })

  it('keeps the Phase 1 round-trip byte-identical after building and resolving a model', () => {
    // Reading must not mutate. If buildModel or resolveModel ever marks an object dirty, the
    // emitter re-renders it and the Phase 1 guarantee is gone.
    for (const { label, path } of corpus) {
      const source = readFileSync(path, 'utf8')
      const doc = parseIdf(source)
      resolveModel(buildModel(doc))
      expect(emitIdf(doc) === source, `${label} no longer round-trips`).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // Spec invariants — independent of how the transform is implemented
  // -------------------------------------------------------------------------

  it('turns each surface normal clockwise by exactly the angles that apply to it', () => {
    const failures: string[] = []
    let checked = 0
    let withRotation = 0

    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      const r = checkNormalRotation(label, model, resolved, failures)
      checked += r.checked
      withRotation += r.withRotation
    }

    expect(checked).toBeGreaterThan(1000)
    // Files where the answer is not simply zero, so the assertion has something to bite on.
    expect(withRotation).toBeGreaterThan(0)
    expect(failures.slice(0, 20)).toEqual([])
  })

  it('resolves by a rigid motion: every edge length is preserved', () => {
    const failures: string[] = []
    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      checkRigidMotion(label, model, resolved, failures)
    }
    expect(failures.slice(0, 20)).toEqual([])
  })

  it('translates z by the zone origin and nothing else', () => {
    const failures: string[] = []
    let checked = 0
    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      checked += checkZTranslation(label, model, resolved, failures)
    }
    expect(checked).toBeGreaterThan(1000)
    expect(failures.slice(0, 20)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Injected rotations
// ---------------------------------------------------------------------------

/**
 * The same model with rotations forced onto it.
 *
 * Purely synthetic — no IDF is rewritten and nothing is saved. The point is that the corpus's
 * geometry is real and varied (concave floors, triangular gables, 8-sided surfaces, surfaces
 * at every tilt) while its *angles* are almost all zero. Overriding the angles puts that
 * geometry through the transform paths the files themselves never take.
 *
 * The angles are deliberately awkward: coprime-ish, none a multiple of 45, none summing to a
 * multiple of 90. A transposed sine, a swapped pair of angles, or an omitted term all move a
 * vertex measurably rather than landing back on a symmetry.
 */
function withRotations(
  model: Model,
  angles: { coordinateSystem: CoordinateSystem; northAxis: number; zoneNorth: number; appendixG: number },
): Model {
  const zones = new Map<string, Zone>()
  for (const [id, zone] of model.zones) {
    zones.set(id, { ...zone, directionOfRelativeNorth: angles.zoneNorth })
  }
  return {
    ...model,
    rules: { ...model.rules, coordinateSystem: angles.coordinateSystem },
    site: { ...model.site, northAxis: angles.northAxis, appendixGRotation: angles.appendixG },
    zones,
  }
}

const INJECTED = [
  {
    name: 'Relative, with a zone north, a building north and an Appendix G rotation',
    angles: { coordinateSystem: 'Relative' as const, northAxis: 23, zoneNorth: 37, appendixG: 11 },
  },
  {
    // The zone term dropped, so a resolver that folded it into the building term shows up.
    name: 'Relative, with only a building north axis',
    angles: { coordinateSystem: 'Relative' as const, northAxis: 23, zoneNorth: 0, appendixG: 0 },
  },
  {
    // The building term dropped, so the zone rotation is on its own and a transposed sine
    // has nothing to hide behind.
    name: 'Relative, with only a zone relative north',
    angles: { coordinateSystem: 'Relative' as const, northAxis: 0, zoneNorth: 37, appendixG: 0 },
  },
  {
    // The Appendix G trap. No corpus file exercises this path at all.
    name: 'World, with an Appendix G rotation',
    angles: { coordinateSystem: 'World' as const, northAxis: 23, zoneNorth: 37, appendixG: 11 },
  },
]

describe.skipIf(corpus.length === 0)('Phase 2 invariants under injected rotations', () => {
  for (const { name, angles } of INJECTED) {
    describe(name, () => {
      it('turns each surface normal clockwise by exactly the angles that apply to it', () => {
        const failures: string[] = []
        let checked = 0
        let withRotation = 0
        for (const { label, path } of corpus) {
          const model = withRotations(load(path).model, angles)
          const r = checkNormalRotation(label, model, resolveModel(model), failures)
          checked += r.checked
          withRotation += r.withRotation
        }
        expect(checked).toBeGreaterThan(1000)
        expect(withRotation).toBeGreaterThan(1000)
        expect(failures.slice(0, 20)).toEqual([])
      })

      it('resolves by a rigid motion: every edge length is preserved', () => {
        const failures: string[] = []
        for (const { label, path } of corpus) {
          const model = withRotations(load(path).model, angles)
          checkRigidMotion(label, model, resolveModel(model), failures)
        }
        expect(failures.slice(0, 20)).toEqual([])
      })

      it('translates z by the zone origin and nothing else', () => {
        const failures: string[] = []
        let checked = 0
        for (const { label, path } of corpus) {
          const model = withRotations(load(path).model, angles)
          checked += checkZTranslation(label, model, resolveModel(model), failures)
        }
        expect(checked).toBeGreaterThan(1000)
        expect(failures.slice(0, 20)).toEqual([])
      })
    })
  }
})

// ---------------------------------------------------------------------------
// Triangulation over the corpus (Phase 3)
// ---------------------------------------------------------------------------

/**
 * `triangulate.test.ts` checks the algorithm on shapes chosen to break it. This checks it on
 * every surface in every file, which is the only way to find out what real IDF geometry
 * actually contains: 8-sided walls, floors with courtyards, roofs that are 0.25 mm out of
 * plane, surfaces with a repeated vertex.
 *
 * Areas are compared against the Newell area rather than against a stored expectation,
 * because the point is agreement between two independent computations — a vector sum over
 * edges versus a sum over clipped ears.
 */
describe.skipIf(corpus.length === 0)(`Triangulation over ${corpus.length} corpus files`, () => {
  it('tessellates every surface, with every triangle facing the surface normal', () => {
    const areaFailures: string[] = []
    const windingFailures: string[] = []
    const emptyFailures: string[] = []
    let surfaces = 0
    let triangles = 0
    let worstAreaError = 0

    for (const { label, path } of corpus) {
      const { model, resolved } = load(path)
      for (const [id, r] of resolved) {
        const name = `${label}:${model.surfaces.get(id)?.name ?? id}`
        const verts = r.worldVertices
        surfaces++
        triangles += r.triangles.length / 3

        for (const i of r.triangles) {
          if (i >= verts.length) emptyFailures.push(`${name}: index ${i} out of range`)
        }

        // A surface with 3+ vertices and a nonzero area must produce triangles. Anything
        // that silently renders as nothing is worse than a validation error.
        if (verts.length >= 3 && r.area > 1e-9 && r.triangles.length === 0) {
          emptyFailures.push(`${name}: ${verts.length} vertices, area ${r.area}, 0 triangles`)
          continue
        }
        if (r.triangles.length === 0) continue

        let sum = 0
        for (let t = 0; t < r.triangles.length; t += 3) {
          const a = verts[r.triangles[t]!]!
          const b = verts[r.triangles[t + 1]!]!
          const c = verts[r.triangles[t + 2]!]!
          const ux = b.x - a.x
          const uy = b.y - a.y
          const uz = b.z - a.z
          const wx = c.x - a.x
          const wy = c.y - a.y
          const wz = c.z - a.z
          const nx = uy * wz - uz * wy
          const ny = uz * wx - ux * wz
          const nz = ux * wy - uy * wx
          const mag = Math.hypot(nx, ny, nz)
          sum += mag / 2
          // Skip slivers: a triangle with no area has no meaningful orientation, and real
          // files contain them (repeated vertices, 1e-9 m edges).
          if (mag < 1e-12) continue
          const facing = (nx * r.normal.x + ny * r.normal.y + nz * r.normal.z) / mag
          if (facing < 0.5) windingFailures.push(`${name}: tri ${t / 3} facing ${facing}`)
        }

        const error = Math.abs(sum - r.area) / Math.max(r.area, 1e-6)
        if (error > worstAreaError) worstAreaError = error
        if (error > 1e-6) {
          areaFailures.push(`${name}: earcut ${sum} vs Newell ${r.area} (${error})`)
        }
      }
    }

    expect(surfaces).toBeGreaterThan(1000)
    expect(triangles).toBeGreaterThan(1000)
    expect(emptyFailures.slice(0, 20)).toEqual([])
    expect(windingFailures.slice(0, 20)).toEqual([])
    expect(areaFailures.slice(0, 20)).toEqual([])
    expect(worstAreaError).toBeLessThan(1e-6)
  })
})

// ---------------------------------------------------------------------------
// Phase 4 gate over 182 corpus files
// ---------------------------------------------------------------------------

/**
 * PHASE 4 GATE (docs/05-implementation-plan.md)
 *
 *   Run over the whole EnergyPlus ExampleFiles/ corpus. Every reported error on a
 *   shipped example file is either a real defect in that file or a bug in our validator —
 *   triage all of them. False positives here destroy trust faster than missing features.
 *
 * Triage outcome:
 *   Exactly 4 errors across all 8,666 surfaces in 182 files: all 4 are in
 *   `ASHRAE901_OfficeLarge_STD2019_Denver_Chiller205_Detailed.idf`, where
 *   `Core_top_ZN_5_Wall_South`, `Core_top_ZN_5_Wall_West`,
 *   `Core_top_ZN_5_Wall_South-PPAutoCreateOther`, and `DataCenter_top_ZN_6_Wall_East`
 *   name the wrong partner zone in their OBC Object fields (e.g. Core_bot instead of
 *   Core_top). This is a confirmed defect in that shipped EnergyPlus model.
 *
 *   Zero false-positive errors on any other file across the corpus.
 */
describe.skipIf(corpus.length === 0)(`Phase 4 gate over ${corpus.length} corpus files`, () => {
  it('validates the corpus with zero untriaged errors', () => {
    const untriagedErrors: Array<{ file: string; surface: string; code: string; message: string }> = []
    let totalSurfaces = 0
    let totalIssues = 0

    const KNOWN_DEFECT_FILE = 'ASHRAE901_OfficeLarge_STD2019_Denver_Chiller205_Detailed.idf'
    const KNOWN_DEFECT_SURFACES = new Set([
      'Core_top_ZN_5_Wall_South',
      'Core_top_ZN_5_Wall_West',
      'Core_top_ZN_5_Wall_South-PPAutoCreateOther',
      'DataCenter_top_ZN_6_Wall_East',
    ])

    for (const { label, path } of corpus) {
      const doc = parseIdf(readFileSync(path, 'utf8'))
      const model = buildModel(doc)
      const resolved = resolveModel(model)
      const report = validateModel(model, resolved, doc)

      totalSurfaces += model.surfaces.size
      totalIssues += report.issues.length

      for (const issue of report.issues) {
        if (issue.severity === 'error') {
          const isKnownDefect =
            label.endsWith(KNOWN_DEFECT_FILE) &&
            issue.code === 'boundary-asymmetric' &&
            KNOWN_DEFECT_SURFACES.has(issue.objectName)

          if (!isKnownDefect) {
            untriagedErrors.push({
              file: label,
              surface: issue.objectName,
              code: issue.code,
              message: issue.message,
            })
          }
        }
      }
    }

    expect(totalSurfaces).toBeGreaterThan(8000)
    expect(totalIssues).toBeGreaterThan(0)
    expect(untriagedErrors).toEqual([])
  })
})
