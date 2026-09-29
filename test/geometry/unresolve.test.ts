import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import type { Surface, Vec3 } from '../../src/model/index.js'
import {
  formatCoordinate,
  isDetachedBuildingShading,
  resolveModel,
  resolveSurface,
  setVertexWorld,
  transformContext,
  unresolveForSurface,
  unresolveVertex,
  vertexFieldSlot,
  zoneForSurface,
} from '../../src/geometry/index.js'

/**
 * PHASE 6 — the inverse-transform invariant.
 *
 * `unresolve(resolve(v)) === v`, for every vertex of every surface in the corpus.
 *
 * This is the single most load-bearing test of the editing phase. A vertex drag happens in
 * world space but must be written back in the file's own space, and the two are separated by
 * up to three rotations and a translation. If any one of those is inverted with the wrong
 * sign, the resolver and the un-resolver disagree, and every edit writes a plausible-looking
 * but wrong coordinate — the same failure mode Phase 2 was built to prevent, now on the
 * write path where it actually damages the user's file.
 *
 * As in `corpus.test.ts`, the corpus as written barely exercises the rotations: no file
 * carries an Appendix G angle and only one has a nonzero Direction of Relative North (180
 * degrees, whose sine is zero). So the second pass injects angles whose sines and cosines are
 * all distinct and nonzero, which is what makes a transposed sine detectable.
 */

const BULK_DIR = join(import.meta.dirname, '../fixtures/testfiles')
const VERSIONS_DIR = join(import.meta.dirname, '../fixtures/versions')

function listCorpus(): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = []
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

/** Largest component-wise difference between two points, in metres. */
function maxDelta(a: Vec3, b: Vec3): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))
}

/**
 * Check `unresolve(resolve(v)) === v` for every vertex of every surface in a model.
 * Returns the worst error seen, and where.
 */
function worstRoundTripError(model: Model): { error: number; where: string; vertices: number } {
  const ctx = transformContext(model)
  const resolved = resolveModel(model)
  let worst = 0
  let where = 'none'
  let vertices = 0

  for (const [id, surface] of model.surfaces) {
    const r = resolved.get(id)
    if (!r) continue
    for (let i = 0; i < r.worldVertices.length; i++) {
      const sourceIdx = r.sourceIndex[i]
      if (sourceIdx === undefined) continue
      const original = surface.vertices[sourceIdx]
      if (!original) continue

      const back = unresolveForSurface(model, surface, ctx, r.worldVertices[i]!)
      vertices++
      const err = maxDelta(back, original)
      if (err > worst) {
        worst = err
        where = `${surface.name} vertex ${sourceIdx + 1}`
      }
    }
  }
  return { error: worst, where, vertices }
}

/**
 * Angles chosen so every sine and cosine involved is distinct and nonzero. A transposed
 * sine, a rotation applied in the wrong order, or the building angle used where the zone
 * angle belongs all produce a visible error; with the corpus's own zero angles, none would.
 */
function injectRotations(model: Model): void {
  model.site.northAxis = 37
  model.site.appendixGRotation = 23
  let i = 0
  for (const zone of model.zones.values()) {
    zone.directionOfRelativeNorth = [11, 59, 127, 246, 313][i % 5]!
    i++
  }
}

describe('unresolve — inverse coordinate resolution', () => {
  it.skipIf(corpus.length === 0)(
    'round-trips every corpus vertex through resolve then unresolve',
    () => {
      let checked = 0
      let worst = 0
      let worstLabel = ''

      for (const { label, path } of corpus) {
        const model = buildModel(parseIdf(readFileSync(path, 'utf8')))
        const { error, where, vertices } = worstRoundTripError(model)
        checked += vertices
        if (error > worst) {
          worst = error
          worstLabel = `${label}: ${where}`
        }
        expect(error, `${label}: ${where} did not survive the round trip`).toBeLessThan(1e-9)
      }

      expect(checked, 'corpus produced no vertices to check').toBeGreaterThan(10_000)
      console.log(
        `unresolve round-trip: ${checked} vertices across ${corpus.length} files, ` +
          `worst error ${worst.toExponential(2)} m (${worstLabel || 'exact'})`,
      )
    },
  )

  it.skipIf(corpus.length === 0)(
    'round-trips with building, Appendix G, and zone rotations injected',
    () => {
      let checked = 0
      let worst = 0

      for (const { label, path } of corpus) {
        const model = buildModel(parseIdf(readFileSync(path, 'utf8')))
        injectRotations(model)
        const { error, where, vertices } = worstRoundTripError(model)
        checked += vertices
        worst = Math.max(worst, error)
        expect(error, `${label}: ${where} did not survive the rotated round trip`).toBeLessThan(
          1e-9,
        )
      }

      expect(checked).toBeGreaterThan(10_000)
      console.log(
        `unresolve round-trip (rotated): ${checked} vertices, worst error ${worst.toExponential(2)} m`,
      )
    },
  )

  it('is the exact inverse of resolveVertex for a World file with an Appendix G angle', () => {
    // World coordinates ignore zone origin and North Axis but *not* Appendix G — the trap
    // documented in docs/03-idf-geometry.md. A vertex on a zone surface must come back
    // through the Appendix G rotation; one on detached site shading must not move at all.
    const ctx = {
      coordinateSystem: 'World' as const,
      buildingRelNorth: { cos: Math.cos(0.4), sin: Math.sin(0.4) },
      appendixGOnly: { cos: Math.cos(0.3), sin: Math.sin(0.3) },
      zoneRotation: new Map([['z', { cos: Math.cos(0.7), sin: Math.sin(0.7) }]]),
    }
    const zone = {
      id: 'z',
      name: 'Z',
      directionOfRelativeNorth: 0,
      origin: { x: 3, y: -4, z: 2 },
      multiplier: 1,
      type: '',
    }
    const v = { x: 12.5, y: -7.25, z: 3.125 }

    const world = unresolveVertex(v, ctx, zone, false)
    expect(maxDelta(world, v)).toBeGreaterThan(0) // Appendix G did rotate it
    // Round-tripping through the forward transform must return the original.
    const forward = {
      x: world.x * ctx.appendixGOnly.cos - world.y * ctx.appendixGOnly.sin,
      y: world.x * ctx.appendixGOnly.sin + world.y * ctx.appendixGOnly.cos,
      z: world.z,
    }
    expect(maxDelta(forward, v)).toBeLessThan(1e-12)

    // Detached site shading: no zone, not building shading, so nothing applies.
    expect(unresolveVertex(v, ctx, undefined, false)).toEqual(v)
  })
})

// ---------------------------------------------------------------------------
// The permutation trap
// ---------------------------------------------------------------------------

/**
 * A file that is Clockwise *and* starts at LowerRightCorner, so the resolved vertex order is
 * a non-trivial permutation of the written order. Writing resolved vertex 0 back to written
 * vertex 0 would pass every test on a default UpperLeftCorner/Counterclockwise file and
 * corrupt this one.
 */
const PERMUTED_FIXTURE = `Version,24.2;

Building,
  Test Building,
  30.0,                    !- North Axis
  ,
  ,
  ,
  ,
  ,
  ,
  ;

GlobalGeometryRules,
  LowerRightCorner,        !- Starting Vertex Position
  Clockwise,               !- Vertex Entry Direction
  Relative,                !- Coordinate System
  Relative,                !- Daylighting Reference Point Coordinate System
  Relative;                !- Rectangular Surface Coordinate System

Zone,
  Zone1,                   !- Name
  45.0,                    !- Direction of Relative North
  10.0,                    !- X Origin
  20.0,                    !- Y Origin
  1.0,                     !- Z Origin
  ,
  ,
  ,
  ,
  ;

BuildingSurface:Detailed,
  Wall1,                   !- Name
  Wall,                    !- Surface Type
  Constr1,                 !- Construction Name
  Zone1,                   !- Zone Name
  ,                        !- Space Name
  Outdoors,                !- Outside Boundary Condition
  ,                        !- Outside Boundary Condition Object
  SunExposed,              !- Sun Exposure
  WindExposed,             !- Wind Exposure
  ,                        !- View Factor to Ground
  4,                       !- Number of Vertices
  0.0, 0.0, 3.0,           !- X,Y,Z Vertex 1
  0.0, 0.0, 0.0,           !- X,Y,Z Vertex 2
  5.0, 0.0, 0.0,           !- X,Y,Z Vertex 3
  5.0, 0.0, 3.0;           !- X,Y,Z Vertex 4
`

function loadPermuted() {
  const doc = parseIdf(PERMUTED_FIXTURE)
  const model = buildModel(doc)
  const surface = [...model.surfaces.values()][0]!
  return { doc, model, surface }
}

describe('setVertexWorld — writing through the vertex permutation', () => {
  it('reads a fixture whose vertex order really is permuted', () => {
    const { model, surface } = loadPermuted()
    expect(model.rules.vertexEntryDirection).toBe('Clockwise')
    expect(model.rules.startingVertexPosition).toBe('LowerRightCorner')
    expect(surface.vertices).toHaveLength(4)

    const r = resolveSurface(model, surface, transformContext(model))
    // If this were the identity the test below would prove nothing.
    expect(r.sourceIndex).not.toEqual([0, 1, 2, 3])
  })

  it('writes the moved vertex to the fields the resolved index actually came from', () => {
    const { doc, model, surface } = loadPermuted()
    const ctx = transformContext(model)
    const before = resolveSurface(model, surface, ctx)
    const beforeFields = doc.objects.get(surface.id)!.fields.map((f) => f.value)

    const resolvedIndex = 1
    const slot = vertexFieldSlot(model, surface, resolvedIndex)!
    expect(slot.sourceIndex).toBe(before.sourceIndex[resolvedIndex])

    const target = {
      x: before.worldVertices[resolvedIndex]!.x,
      y: before.worldVertices[resolvedIndex]!.y,
      z: before.worldVertices[resolvedIndex]!.z + 1.5,
    }
    const result = setVertexWorld(doc, model, surface.id, resolvedIndex, target, ctx)
    expect(result.changed).toBe(true)
    expect(result.dirtied).toEqual([surface.id])

    // The moved point must land exactly where it was put, after re-resolving.
    const after = resolveSurface(model, surface, ctx)
    expect(maxDelta(after.worldVertices[resolvedIndex]!, target)).toBeLessThan(1e-9)

    // Every other resolved vertex is untouched.
    for (let i = 0; i < after.worldVertices.length; i++) {
      if (i === resolvedIndex) continue
      expect(maxDelta(after.worldVertices[i]!, before.worldVertices[i]!), `vertex ${i}`).toBeLessThan(
        1e-12,
      )
    }

    // Exactly one vertex's worth of fields changed, and it is the Z of the source vertex.
    const afterFields = doc.objects.get(surface.id)!.fields.map((f) => f.value)
    const changedIdx = afterFields
      .map((v, i) => (v === beforeFields[i] ? -1 : i))
      .filter((i) => i >= 0)
    expect(changedIdx).toEqual([slot.fieldIndex + 2])
  })

  it('leaves the file byte-identical when a vertex is set to the value it already has', () => {
    const { doc, model, surface } = loadPermuted()
    const ctx = transformContext(model)
    const resolved = resolveSurface(model, surface, ctx)

    for (let i = 0; i < resolved.worldVertices.length; i++) {
      const result = setVertexWorld(doc, model, surface.id, i, resolved.worldVertices[i]!, ctx)
      expect(result.changed, `vertex ${i} reported a change it did not make`).toBe(false)
    }

    expect(doc.objects.get(surface.id)!.dirty).toBe(false)
    expect(emitIdf(doc)).toBe(PERMUTED_FIXTURE)
  })
})

describe('formatCoordinate', () => {
  it('discards floating-point noise without moving real geometry', () => {
    expect(formatCoordinate(5)).toBe('5')
    expect(formatCoordinate(4.999999999999999)).toBe('5')
    expect(formatCoordinate(-0)).toBe('0')
    expect(formatCoordinate(6.123233995736766e-17)).toBe('0')
    expect(formatCoordinate(3.048)).toBe('3.048')
    expect(formatCoordinate(-12.192)).toBe('-12.192')
    // A millimetre is real geometry and must survive.
    expect(Number(formatCoordinate(0.001))).toBe(0.001)
  })
})

describe('surface frame helpers', () => {
  it.skipIf(corpus.length === 0)('gives detached building shading no zone, corpus-wide', () => {
    let detached = 0
    let attached = 0

    for (const { label, path } of corpus) {
      const model = buildModel(parseIdf(readFileSync(path, 'utf8')))
      for (const s of model.surfaces.values() as Iterable<Surface>) {
        if (s.kind !== 'shading') continue
        if (isDetachedBuildingShading(s)) {
          detached++
          // The detached-shading branch takes the building rotation and nothing else; if a
          // zone leaked in, resolve and unresolve would take different branches.
          expect(zoneForSurface(model, s), `${label}: ${s.name}`).toBeUndefined()
        } else if (zoneForSurface(model, s) !== undefined) {
          attached++
        }
      }
    }

    // Both branches must actually occur, or the assertion above is vacuous.
    expect(detached, 'corpus contains no detached building shading').toBeGreaterThan(0)
    expect(attached, 'corpus contains no zone-attached shading').toBeGreaterThan(0)
  })
})
