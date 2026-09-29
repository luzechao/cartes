/**
 * Known-answer tests for coordinate resolution.
 *
 * Written before the resolver, and every expected value derived by hand from the
 * definitions in docs/03-idf-geometry.md and from `SurfaceGeometry.cc`. That ordering is the
 * point: a sign error in a rotation produces coordinates that look entirely plausible, so a
 * test whose expectations came out of the implementation would pass just as happily.
 *
 * Derived from EnergyPlus source code; see NOTICE for its copyright notice and license.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import type { Vec3 } from '../../src/model/index.js'
import {
  cornerShiftCount,
  newellNormal,
  orderVertices,
  resolveModel,
  type ResolvedSurface,
} from '../../src/geometry/index.js'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'known-answer')

function load(name: string): Model {
  return buildModel(parseIdf(readFileSync(join(FIXTURES, name), 'utf8')))
}

/** Resolved surfaces keyed by name rather than object id, so the two files line up. */
function resolvedByName(model: Model): Map<string, ResolvedSurface> {
  const out = new Map<string, ResolvedSurface>()
  for (const [id, resolved] of resolveModel(model)) {
    out.set(model.surfaces.get(id)!.name, resolved)
  }
  return out
}

function expectVerticesClose(actual: readonly Vec3[], expected: readonly Vec3[], tol = 1e-6): void {
  expect(actual.length).toBe(expected.length)
  actual.forEach((v, i) => {
    const e = expected[i]!
    expect(Math.abs(v.x - e.x), `vertex ${i + 1} x: ${v.x} vs ${e.x}`).toBeLessThanOrEqual(tol)
    expect(Math.abs(v.y - e.y), `vertex ${i + 1} y: ${v.y} vs ${e.y}`).toBeLessThanOrEqual(tol)
    expect(Math.abs(v.z - e.z), `vertex ${i + 1} z: ${v.z} vs ${e.z}`).toBeLessThanOrEqual(tol)
  })
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

// ---------------------------------------------------------------------------
// The Phase 2 gate
// ---------------------------------------------------------------------------

describe('Phase 2 gate: Relative and World forms of one building agree', () => {
  /**
   * Zone origin (10, 20, 3), Direction of Relative North 90, Building North Axis 90.
   * Both angles are negated and fed through a CCW matrix, so each is a net *clockwise*
   * rotation: theta = -90deg gives cos = 0, sin = -1, i.e. (x, y) -> (y, -x).
   *
   *     rotate by zone north   (x, y)  -> (y, -x)
   *     translate by origin            -> (y + 10, -x + 20)
   *     rotate by bldg north           -> (-x + 20, -y - 10)
   *     z                              -> z + 3
   */
  const expected: Record<string, Vec3[]> = {
    FLOOR: [v(20, -10, 3), v(20, -14, 3), v(14, -14, 3), v(14, -10, 3)],
    'WALL SOUTH': [v(20, -10, 6), v(20, -10, 3), v(14, -10, 3), v(14, -10, 6)],
    'WINDOW SOUTH': [v(19, -10, 5.5), v(19, -10, 3.5), v(15, -10, 3.5), v(15, -10, 5.5)],
    'OVERHANG SOUTH': [v(19, -9.5, 6), v(19, -10, 6), v(15, -10, 6), v(15, -9.5, 6)],
    // Detached building shading: building rotation only. No origin, no z offset.
    CARPORT: [v(10, 0, 4), v(12, 0, 4), v(12, -3, 4), v(10, -3, 4)],
    // Detached site shading is never transformed.
    NEIGHBOUR: [v(30, 30, 0), v(30, 32, 0), v(33, 32, 0), v(33, 30, 0)],
  }

  const relative = resolvedByName(load('gate-relative.idf'))
  const world = resolvedByName(load('gate-world.idf'))

  it('resolves the Relative file to the hand-derived world coordinates', () => {
    for (const [name, want] of Object.entries(expected)) {
      expectVerticesClose(relative.get(name)!.worldVertices, want)
    }
  })

  it('leaves the World file alone, despite a zone origin and two north axes', () => {
    for (const [name, want] of Object.entries(expected)) {
      expectVerticesClose(world.get(name)!.worldVertices, want)
    }
  })

  it('agrees between the two forms within 1e-6 m', () => {
    expect([...world.keys()].sort()).toEqual([...relative.keys()].sort())
    for (const name of relative.keys()) {
      expectVerticesClose(relative.get(name)!.worldVertices, world.get(name)!.worldVertices, 1e-6)
    }
  })

  it('agrees on areas and normals too', () => {
    const areas: Record<string, number> = {
      FLOOR: 24,
      'WALL SOUTH': 18,
      'WINDOW SOUTH': 8,
      'OVERHANG SOUTH': 2,
      CARPORT: 6,
      NEIGHBOUR: 6,
    }
    for (const [name, area] of Object.entries(areas)) {
      expect(relative.get(name)!.area, name).toBeCloseTo(area, 9)
      expect(world.get(name)!.area, name).toBeCloseTo(area, 9)
    }
    // The floor is entered clockwise seen from above, so its outward normal points down;
    // the south wall's interior lies at more negative y, so its outward normal is +y.
    expectVerticesClose([relative.get('FLOOR')!.normal], [v(0, 0, -1)])
    expectVerticesClose([relative.get('WALL SOUTH')!.normal], [v(0, 1, 0)])
  })

  it('reports every surface as planar', () => {
    for (const r of relative.values()) expect(r.planarityError).toBeLessThan(1e-9)
  })
})

// ---------------------------------------------------------------------------
// The Appendix G trap
// ---------------------------------------------------------------------------

describe('Appendix G rotation applies in World coordinates', () => {
  const byName = resolvedByName(load('appendix-g-world.idf'))

  it('rotates zone surfaces by the Appendix G angle', () => {
    // theta = -90deg  =>  (x, y) -> (y, -x), z unchanged.
    expectVerticesClose(byName.get('FLOOR')!.worldVertices, [
      v(0, 0, 1),
      v(4, 0, 1),
      v(4, -6, 1),
      v(0, -6, 1),
    ])
  })

  it('rotates detached building shading as well', () => {
    expectVerticesClose(byName.get('CARPORT')!.worldVertices, [
      v(0, -2, 5),
      v(2, 0, 5),
      v(0, 0, 5),
    ])
  })

  it('exempts detached site shading', () => {
    expectVerticesClose(byName.get('NEIGHBOUR')!.worldVertices, [
      v(9, 0, 0),
      v(0, 9, 0),
      v(0, 0, 0),
    ])
  })

  it('does not fold the Building North Axis into the World-coordinate rotation', () => {
    // North Axis is 45 in this file. Had it been added to the Appendix G angle the floor's
    // second vertex would land near (2.83, -2.83) rather than exactly (4, 0).
    const second = byName.get('FLOOR')!.worldVertices[1]!
    expect(second.x).toBeCloseTo(4, 12)
    expect(second.y).toBeCloseTo(0, 12)
  })
})

// ---------------------------------------------------------------------------
// Vertex ordering
// ---------------------------------------------------------------------------

describe('vertex ordering', () => {
  const quad: Vec3[] = [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)]

  /**
   * EnergyPlus reorders in two steps: reverse v2..vN when the file is Clockwise, then
   * left-rotate so the named corner lands first. The rotation count comes from a while loop
   * in `GetVertices` that walks the corner index up to UpperLeftCorner, each pass performing
   * one left rotation; in closed form that is `(nSides - corner + 1) mod nSides` with
   * corners numbered UpperLeft 1, LowerLeft 2, LowerRight 3, UpperRight 4.
   */
  it('counts corner shifts the way GetVertices does', () => {
    expect(cornerShiftCount(4, 'UpperLeftCorner')).toBe(0)
    expect(cornerShiftCount(4, 'LowerLeftCorner')).toBe(3)
    expect(cornerShiftCount(4, 'LowerRightCorner')).toBe(2)
    expect(cornerShiftCount(4, 'UpperRightCorner')).toBe(1)

    expect(cornerShiftCount(3, 'LowerLeftCorner')).toBe(2)
    expect(cornerShiftCount(3, 'LowerRightCorner')).toBe(1)
    // The `NSides < 4` break: a triangle entered from the upper right is left alone.
    expect(cornerShiftCount(3, 'UpperRightCorner')).toBe(0)

    expect(cornerShiftCount(5, 'LowerLeftCorner')).toBe(4)
    expect(cornerShiftCount(6, 'LowerLeftCorner')).toBe(5)
  })

  it('matches a direct transcription of the GetVertices loop', () => {
    const CORNERS = [
      'UpperLeftCorner',
      'LowerLeftCorner',
      'LowerRightCorner',
      'UpperRightCorner',
    ] as const
    for (let nSides = 3; nSides <= 8; nSides++) {
      for (let c = 1; c <= 4; c++) {
        // Literal port of the C++, 1-indexed, swapping in place.
        const arr = Array.from({ length: nSides }, (_, i) => i)
        let thisCorner = c
        let passes = 0
        while (thisCorner !== 1) {
          if (nSides < 4 && thisCorner === 4) break
          let nTar = thisCorner
          let nSrc = thisCorner + 1 > nSides ? 1 : thisCorner + 1
          for (let n = 1; n <= nSides - 1; n++) {
            const t = arr[nTar - 1]!
            arr[nTar - 1] = arr[nSrc - 1]!
            arr[nSrc - 1] = t
            nTar = nTar + 1 > nSides ? 1 : nTar + 1
            nSrc = nSrc + 1 > nSides ? 1 : nSrc + 1
          }
          passes++
          thisCorner = thisCorner + 1 > nSides ? 1 : thisCorner + 1
        }
        expect(cornerShiftCount(nSides, CORNERS[c - 1]!), `nSides=${nSides} corner=${c}`).toBe(
          passes,
        )
        const k = passes % nSides
        const rotated = arr.map((_, i) => i)
        expect(arr).toEqual(rotated.map((_, i) => (i + k) % nSides))
      }
    }
  })

  it('leaves UpperLeftCorner + Counterclockwise untouched', () => {
    const r = orderVertices(quad, 'UpperLeftCorner', 'Counterclockwise')
    expect(r.sourceIndex).toEqual([0, 1, 2, 3])
    expectVerticesClose(r.vertices, quad)
  })

  it('cyclically relabels for the other corners', () => {
    expect(orderVertices(quad, 'LowerLeftCorner', 'Counterclockwise').sourceIndex).toEqual([
      3, 0, 1, 2,
    ])
    expect(orderVertices(quad, 'LowerRightCorner', 'Counterclockwise').sourceIndex).toEqual([
      2, 3, 0, 1,
    ])
    expect(orderVertices(quad, 'UpperRightCorner', 'Counterclockwise').sourceIndex).toEqual([
      1, 2, 3, 0,
    ])
  })

  it('keeps the first vertex and reverses the rest when entry is Clockwise', () => {
    expect(orderVertices(quad, 'UpperLeftCorner', 'Clockwise').sourceIndex).toEqual([0, 3, 2, 1])
    expect(orderVertices(quad, 'LowerLeftCorner', 'Clockwise').sourceIndex).toEqual([1, 0, 3, 2])
    expect(orderVertices(quad, 'LowerRightCorner', 'Clockwise').sourceIndex).toEqual([2, 1, 0, 3])
    expect(orderVertices(quad, 'UpperRightCorner', 'Clockwise').sourceIndex).toEqual([3, 2, 1, 0])
  })

  /**
   * docs/03-idf-geometry.md used to claim that Starting Vertex Position and Vertex Entry
   * Direction "together determine the surface normal direction". Only the second does: a
   * corner shift is a cyclic relabel, and Newell's method is invariant under one.
   */
  it('leaves the normal alone under a corner shift, and flips it under a reversal', () => {
    const base = newellNormal(quad)
    for (const corner of ['LowerLeftCorner', 'LowerRightCorner', 'UpperRightCorner'] as const) {
      const shifted = newellNormal(orderVertices(quad, corner, 'Counterclockwise').vertices)
      expectVerticesClose([shifted], [base], 1e-12)
    }
    const reversed = newellNormal(orderVertices(quad, 'UpperLeftCorner', 'Clockwise').vertices)
    expectVerticesClose([reversed], [v(-base.x, -base.y, -base.z)], 1e-12)
  })
})

// ---------------------------------------------------------------------------
// Newell normals and planarity
// ---------------------------------------------------------------------------

describe('Newell normals', () => {
  it('gives the right-hand-rule normal for a counter-clockwise polygon', () => {
    expectVerticesClose([newellNormal([v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)])], [v(0, 0, 1)])
  })

  it('handles a vertical surface', () => {
    // In the x-z plane at y = 0, wound so the right-hand rule gives +y:
    // (v2 - v1) x (v3 - v2) = (0,0,1) x (1,0,0) = (0,1,0).
    expectVerticesClose([newellNormal([v(0, 0, 0), v(0, 0, 1), v(1, 0, 1), v(1, 0, 0)])], [v(0, 1, 0)])
  })

  it('is unaffected by a concave vertex, unlike a three-point cross product', () => {
    // An L, counter-clockwise in the x-y plane. Vertices 3 and 4 form the reflex corner, so
    // a normal taken from any three consecutive points there would come out inverted.
    const l = [v(0, 0, 0), v(2, 0, 0), v(2, 1, 0), v(1, 1, 0), v(1, 2, 0), v(0, 2, 0)]
    expectVerticesClose([newellNormal(l)], [v(0, 0, 1)])
  })

  it('returns a zero vector for a degenerate polygon rather than NaN', () => {
    const n = newellNormal([v(0, 0, 0), v(1, 1, 1), v(2, 2, 2)])
    expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)).toBe(true)
    expect(Math.hypot(n.x, n.y, n.z)).toBeLessThan(1e-12)
  })
})
