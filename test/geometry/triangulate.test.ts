/**
 * Triangulation — docs/03-idf-geometry.md §Triangulation.
 *
 * Triangulation is easy to get wrong in ways that look right. A fan from vertex 0 renders a
 * convex room perfectly and puts a phantom flap across every L-shaped floor; a projection
 * that drops a coordinate axis works on a shoebox and collapses on a hipped roof. So the
 * assertions here are all metric rather than structural — sum of triangle areas against the
 * Newell area, per-triangle winding against the surface normal, and the projection tested as
 * an isometry rather than merely as "some 2D layout earcut accepted".
 *
 * The isometry check is the one that earns its keep. Both axis-drop projections produce a
 * *topologically correct* triangulation, so index-level assertions pass for them; only the
 * distortion gives them away. Mutations tried, all killed:
 *
 *   T1  project by dropping the smallest-|normal| axis  → every wall collapses to a line,
 *       0 triangles (this is the shortcut 03-idf-geometry.md warns about by name)
 *   T2  project by dropping the largest-|normal| axis   → topology fine, isometry fails,
 *       and the mirrored frame turns faces inside out
 *   T3  seed the basis with a fixed axis instead of the least-aligned one → floors (seed Z)
 *       or east-facing walls (seed X) degenerate
 *   T4  return earcut's indices unoriented → killed only by the direct `orientTriangles`
 *       test, for the reason below
 *   T5  fan from vertex 0 instead of calling earcut → overshoots on the notched pentagon,
 *       and on the corpus too: real files do contain surfaces that are not star-shaped
 *   T6  triangulate the as-written vertices rather than the reordered world ones → indices
 *       land on the wrong permutation (`corpus.test.ts`)
 *
 * The winding correction needs that direct test because it is unreachable end to end.
 * earcut 3.2 normalises the ring internally and emits counter-clockwise triangles whatever
 * the input winding, so with a right-handed basis it is already correct and removing the
 * correction changes no output — the mutation survives every whole-pipeline assertion here
 * and over all 8666 corpus surfaces. The guard stays because that earcut behaviour is
 * undocumented, and a face-orientation regression is silent. So it is tested against its own
 * contract, and the upstream behaviour it guards against is pinned as a canary.
 */
import { describe, expect, it } from 'vitest'
import earcut from 'earcut'
import type { Vec3 } from '../../src/model/index.js'
import {
  newellNormal,
  orientTriangles,
  planeBasis,
  projectToPlane,
  triangulate,
} from '../../src/geometry/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z)
}

/** Twice the vector area of the polygon; magnitude is 2·area. */
function newellArea(vertices: readonly Vec3[]): number {
  let x = 0
  let y = 0
  let z = 0
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!
    const b = vertices[(i + 1) % n]!
    x += (a.y - b.y) * (a.z + b.z)
    y += (a.z - b.z) * (a.x + b.x)
    z += (a.x - b.x) * (a.y + b.y)
  }
  return Math.hypot(x, y, z) / 2
}

/**
 * Sum of *unsigned* triangle areas. Unsigned matters: a fan across a reflex corner produces
 * a triangle outside the polygon whose signed area cancels the overshoot exactly, so a
 * signed sum would report the right answer for a wrong triangulation.
 */
function triangleAreaSum(vertices: readonly Vec3[], tris: Uint32Array): number {
  let total = 0
  for (let i = 0; i < tris.length; i += 3) {
    const a = vertices[tris[i]!]!
    const b = vertices[tris[i + 1]!]!
    const c = vertices[tris[i + 2]!]!
    total += len(cross(sub(b, a), sub(c, a))) / 2
  }
  return total
}

/** Rotate a point about the X then Z axes — used to tilt fixtures off the world axes. */
function tilt(p: Vec3, pitchDeg: number, yawDeg: number): Vec3 {
  const px = (pitchDeg * Math.PI) / 180
  const yz = (yawDeg * Math.PI) / 180
  const y1 = p.y * Math.cos(px) - p.z * Math.sin(px)
  const z1 = p.y * Math.sin(px) + p.z * Math.cos(px)
  return {
    x: p.x * Math.cos(yz) - y1 * Math.sin(yz),
    y: p.x * Math.sin(yz) + y1 * Math.cos(yz),
    z: z1,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 6 × 4 floor, wound counter-clockwise seen from above, so the normal is +Z. */
const RECT = [v(0, 0, 0), v(6, 0, 0), v(6, 4, 0), v(0, 4, 0)]

/** A north-facing wall: vertical, normal −Y. */
const WALL = [v(0, 0, 0), v(0, 0, 3), v(5, 0, 3), v(5, 0, 0)]

/** An east-facing wall: vertical, normal +X. It is the one that catches a fixed X seed. */
const WALL_EAST = [v(4, 0, 0), v(4, 6, 0), v(4, 6, 3), v(4, 0, 3)]

/**
 * A pentagon with one reflex vertex at (3, 1), poking in from the north edge.
 *
 * Deliberately *not* star-shaped from vertex 0: fanning A–B–C, A–C–D, A–D–E puts A–C–D
 * outside the polygon. True area is 10; the fan's unsigned areas come to 18. So both the
 * area check and the winding check have real bite on this shape.
 */
const NOTCHED = [v(0, 0, 0), v(4, 0, 0), v(4, 4, 0), v(3, 1, 0), v(0, 4, 0)]

/** The same notched shape, tilted well off every world axis. */
const NOTCHED_TILTED = NOTCHED.map((p) => tilt(p, 63, 27))

const SHAPES: Array<[string, Vec3[]]> = [
  ['rectangular floor', RECT],
  ['north wall', WALL],
  ['east wall', WALL_EAST],
  ['reversed floor (normal −Z)', [...RECT].reverse()],
  ['notched pentagon', NOTCHED],
  ['notched pentagon, tilted 63°/27°', NOTCHED_TILTED],
  ['gable end', [v(0, 0, 0), v(8, 0, 0), v(8, 0, 3), v(4, 0, 5), v(0, 0, 3)]],
  ['steep roof plane', [v(0, 0, 0), v(6, 0, 0), v(6, 4, 20), v(0, 4, 20)]],
  ['near-vertical sliver', [v(0, 0, 0), v(6, 0.001, 0), v(6, 0.001, 3), v(0, 0, 3)]],
  ['far from the origin', RECT.map((p) => v(p.x + 512345.5, p.y + 4283100.25, p.z + 120))],
]

// ---------------------------------------------------------------------------
// The plane basis
// ---------------------------------------------------------------------------

describe('planeBasis', () => {
  const NORMALS: Vec3[] = [
    v(0, 0, 1),
    v(0, 0, -1),
    v(1, 0, 0),
    v(-1, 0, 0),
    v(0, 1, 0),
    v(0, -1, 0),
    v(0.6, 0.8, 0),
    v(1, 1, 1),
    v(1e-9, 1e-9, 1),
    v(3, -4, 12),
  ]

  it('returns an orthonormal frame for every direction, including the world axes', () => {
    for (const raw of NORMALS) {
      const n = { x: raw.x / len(raw), y: raw.y / len(raw), z: raw.z / len(raw) }
      const b = planeBasis(raw)
      const label = JSON.stringify(raw)
      expect(len(b.u), label).toBeCloseTo(1, 12)
      expect(len(b.v), label).toBeCloseTo(1, 12)
      expect(dot(b.u, b.v), label).toBeCloseTo(0, 12)
      expect(dot(b.u, n), label).toBeCloseTo(0, 12)
      expect(dot(b.v, n), label).toBeCloseTo(0, 12)
    }
  })

  /**
   * Right-handed, with u × v = n. Get this backwards and every polygon projects mirrored;
   * the per-triangle winding fix in `triangulate` would paper over it, so it is pinned here
   * where nothing can compensate.
   */
  it('is right-handed about the normal', () => {
    for (const raw of NORMALS) {
      const n = { x: raw.x / len(raw), y: raw.y / len(raw), z: raw.z / len(raw) }
      const b = planeBasis(raw)
      const c = cross(b.u, b.v)
      expect(dot(c, n), JSON.stringify(raw)).toBeCloseTo(1, 12)
    }
  })

  it('gives up rather than returning NaN for a zero or non-finite normal', () => {
    for (const bad of [v(0, 0, 0), v(NaN, 0, 1), v(0, Infinity, 0)]) {
      const b = planeBasis(bad)
      expect(b.u, JSON.stringify(bad)).toEqual({ x: 0, y: 0, z: 0 })
      expect(b.v, JSON.stringify(bad)).toEqual({ x: 0, y: 0, z: 0 })
    }
  })
})

describe('projectToPlane', () => {
  /**
   * The point of building a basis at all. Any axis-drop projection is affine but not rigid:
   * it scales one direction by the cosine of the surface's tilt, which is exactly the
   * degradation `03-idf-geometry.md` warns about. A proper basis makes the projection a
   * rigid motion, so every distance survives it unchanged — and that is checkable.
   */
  it('preserves every pairwise distance, i.e. it is a rigid motion', () => {
    for (const [label, shape] of SHAPES) {
      const flat = projectToPlane(shape, planeBasis(newellNormal(shape)))
      for (let i = 0; i < shape.length; i++) {
        for (let j = i + 1; j < shape.length; j++) {
          const d3 = len(sub(shape[i]!, shape[j]!))
          const d2 = Math.hypot(flat[i * 2]! - flat[j * 2]!, flat[i * 2 + 1]! - flat[j * 2 + 1]!)
          expect(d2, `${label} ${i}-${j}`).toBeCloseTo(d3, 9)
        }
      }
    }
  })

  it('puts the first vertex at the origin, so large site coordinates stay conditioned', () => {
    const shape = SHAPES.find(([l]) => l === 'far from the origin')![1]
    const flat = projectToPlane(shape, planeBasis(newellNormal(shape)))
    expect(flat[0]).toBe(0)
    expect(flat[1]).toBe(0)
  })

  it('returns nothing for an empty polygon', () => {
    expect(projectToPlane([], planeBasis(v(0, 0, 1)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Triangulation
// ---------------------------------------------------------------------------

describe('triangulate', () => {
  it('produces n−2 triangles indexing only real vertices', () => {
    for (const [label, shape] of SHAPES) {
      const tris = triangulate(shape, newellNormal(shape))
      expect(tris.length, label).toBe((shape.length - 2) * 3)
      for (const i of tris) expect(i, label).toBeLessThan(shape.length)
    }
  })

  /**
   * Unsigned areas, so an ear clipped outside the polygon shows up as an overshoot rather
   * than cancelling. On `NOTCHED` a fan from vertex 0 gives 18 against a true area of 10.
   */
  it('tessellates the polygon exactly — no gaps, no overlaps, no overshoot', () => {
    for (const [label, shape] of SHAPES) {
      const expected = newellArea(shape)
      const tris = triangulate(shape, newellNormal(shape))
      expect(triangleAreaSum(shape, tris) / expected, label).toBeCloseTo(1, 9)
    }
  })

  it('agrees on the two areas it can be checked against by hand', () => {
    expect(newellArea(RECT)).toBeCloseTo(24, 12)
    expect(triangleAreaSum(RECT, triangulate(RECT, newellNormal(RECT)))).toBeCloseTo(24, 12)
    expect(newellArea(NOTCHED)).toBeCloseTo(10, 12)
    expect(triangleAreaSum(NOTCHED, triangulate(NOTCHED, newellNormal(NOTCHED)))).toBeCloseTo(
      10,
      12,
    )
  })

  /**
   * Every triangle wound the same way as the surface. A back-facing triangle is invisible
   * under any back-face-culling material, so one flipped ear is a hole in the wall — and a
   * uniformly flipped model is a building lit from the inside.
   */
  it('winds every triangle counter-clockwise about the surface normal', () => {
    for (const [label, shape] of SHAPES) {
      const n = newellNormal(shape)
      const tris = triangulate(shape, n)
      for (let i = 0; i < tris.length; i += 3) {
        const a = shape[tris[i]!]!
        const b = shape[tris[i + 1]!]!
        const c = shape[tris[i + 2]!]!
        const face = cross(sub(b, a), sub(c, a))
        // Normalised, so the threshold means "at least 45° from edge-on", not "positive by
        // some absolute amount that a small triangle could never reach".
        expect(dot(face, n) / len(face), `${label} tri ${i / 3}`).toBeGreaterThan(0.5)
      }
    }
  })

  it('follows the normal it is handed, not the winding it infers', () => {
    // Same polygon, opposite normal: the caller is authoritative, because the normal has
    // already been through vertex reordering and the coordinate transform.
    const flipped = triangulate(RECT, v(0, 0, -1))
    for (let i = 0; i < flipped.length; i += 3) {
      const a = RECT[flipped[i]!]!
      const b = RECT[flipped[i + 1]!]!
      const c = RECT[flipped[i + 2]!]!
      expect(cross(sub(b, a), sub(c, a)).z).toBeLessThan(0)
    }
  })

  it('is insensitive to the length of the normal it is given', () => {
    const n = newellNormal(NOTCHED_TILTED)
    const scaled = v(n.x * 137, n.y * 137, n.z * 137)
    expect([...triangulate(NOTCHED_TILTED, scaled)]).toEqual([
      ...triangulate(NOTCHED_TILTED, n),
    ])
  })
})

// ---------------------------------------------------------------------------
// Winding correction
// ---------------------------------------------------------------------------

describe('orientTriangles', () => {
  // A unit square in the projected frame: (0,0) (1,0) (1,1) (0,1).
  const SQUARE = [0, 0, 1, 0, 1, 1, 0, 1]

  it('reverses a clockwise triangle and leaves a counter-clockwise one alone', () => {
    expect([...orientTriangles(SQUARE, [0, 1, 2])]).toEqual([0, 1, 2])
    expect([...orientTriangles(SQUARE, [0, 2, 1])]).toEqual([0, 1, 2])
  })

  it('orients each triangle independently', () => {
    expect([...orientTriangles(SQUARE, [0, 1, 2, 0, 3, 2])]).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('leaves a zero-area triangle alone rather than flipping on a rounding sign', () => {
    const collinear = [0, 0, 1, 0, 2, 0]
    expect([...orientTriangles(collinear, [0, 1, 2])]).toEqual([0, 1, 2])
  })

  it('drops a trailing partial triangle rather than reading past the end', () => {
    expect([...orientTriangles(SQUARE, [0, 1, 2, 3])]).toEqual([0, 1, 2])
  })

  /**
   * A canary, not a dependency. `triangulate` corrects winding itself precisely so that this
   * behaviour need not be trusted — but it is undocumented, so if an earcut upgrade changes
   * it, this fails and tells whoever is reading that the correction has stopped being a
   * no-op. Without it the upgrade would be silent and the correction untested.
   */
  it('pins the earcut behaviour it guards against: CCW output whatever the input winding', () => {
    const ccw = [0, 0, 4, 0, 4, 3, 0, 3]
    const cw = [0, 0, 0, 3, 4, 3, 4, 0]
    for (const [label, poly] of [['ccw', ccw] as const, ['cw', cw] as const]) {
      const tris = earcut(poly, undefined, 2)
      expect(tris.length, label).toBe(6)
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!]
        const area =
          (poly[b * 2]! - poly[a * 2]!) * (poly[c * 2 + 1]! - poly[a * 2 + 1]!) -
          (poly[b * 2 + 1]! - poly[a * 2 + 1]!) * (poly[c * 2]! - poly[a * 2]!)
        expect(area, `${label} tri ${t / 3}`).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

describe('degenerate surfaces', () => {
  /**
   * These reach us from real files — a surface with two identical vertices, a "wall" whose
   * four corners are collinear. Layer 4 hands the result straight to a GPU buffer, so the
   * contract is an empty triangle list, never a NaN.
   */
  it('yields no triangles rather than NaN', () => {
    const cases: Array<[string, Vec3[]]> = [
      ['empty', []],
      ['one vertex', [v(0, 0, 0)]],
      ['two vertices', [v(0, 0, 0), v(1, 0, 0)]],
      ['three collinear', [v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)]],
      ['all coincident', [v(1, 2, 3), v(1, 2, 3), v(1, 2, 3)]],
      ['non-finite coordinate', [v(0, 0, 0), v(NaN, 0, 0), v(1, 1, 0)]],
    ]
    for (const [label, shape] of cases) {
      const tris = triangulate(shape, newellNormal(shape))
      expect(tris, label).toBeInstanceOf(Uint32Array)
      expect(tris.length, label).toBe(0)
    }
  })

  it('yields no triangles when the normal is zero, whatever the vertices', () => {
    expect(triangulate(RECT, v(0, 0, 0)).length).toBe(0)
  })

  /**
   * A duplicated vertex is not degenerate — the rest of the polygon is still a surface. E+
   * warns about these and carries on, and so should we: dropping the whole wall would be a
   * worse lie than drawing it.
   */
  it('still triangulates a polygon with one duplicated vertex', () => {
    const shape = [v(0, 0, 0), v(6, 0, 0), v(6, 0, 0), v(6, 4, 0), v(0, 4, 0)]
    const tris = triangulate(shape, newellNormal(shape))
    expect(triangleAreaSum(shape, tris)).toBeCloseTo(24, 9)
  })
})
