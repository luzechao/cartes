/**
 * Triangulation — the second half of Layer 3 in docs/04-architecture.md.
 *
 * WebGL draws triangles; IDF surfaces are arbitrary planar polygons, often concave (an
 * L-shaped floor, a wall with a notch) and occasionally many-sided. earcut solves that, but
 * earcut is 2D, so the polygon has to be flattened first.
 *
 * The flattening is the whole subtlety. Per `03-idf-geometry.md` §Triangulation:
 *
 *   1. Newell normal (already computed by `resolve.ts`).
 *   2. An orthonormal basis in the polygon's plane.
 *   3. Project every vertex into that basis.
 *   4. earcut.
 *   5. Use the resulting indices against the *original 3D vertices*.
 *
 * Projecting by dropping a coordinate axis is the tempting shortcut and is rejected here: it
 * is an affine squash, not an isometry, so it distorts the polygon by a factor that depends
 * on the surface's tilt. A proper basis costs about ten lines and makes step 3 a rigid
 * motion, which is what lets `triangulate.test.ts` assert that 2D and 3D areas agree exactly.
 */
import earcut from 'earcut'
import type { Vec3 } from '../model/index.js'

/**
 * A right-handed orthonormal frame with `u × v = normal`, so a polygon wound
 * counter-clockwise about `normal` projects to a counter-clockwise polygon in (u, v).
 */
export interface PlaneBasis {
  u: Vec3
  v: Vec3
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (!(len > 0)) return ZERO
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function isZero(v: Vec3): boolean {
  return v.x === 0 && v.y === 0 && v.z === 0
}

/**
 * Build an in-plane basis for a surface normal, which need not be unit length.
 *
 * The seed axis is whichever world axis the normal leans on *least*, which maximises the
 * length of the cross product and so keeps the normalisation well conditioned. Seeding with a
 * fixed axis instead would collapse for any surface parallel to it — and "parallel to Z" is
 * every floor and roof in every file, so that failure is not hypothetical.
 *
 * Returns a zero basis for a zero or non-finite normal; callers treat that as "not a surface".
 */
export function planeBasis(normal: Vec3): PlaneBasis {
  const n = normalize(normal)
  if (isZero(n)) return { u: ZERO, v: ZERO }

  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  const seed: Vec3 =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 }

  const u = normalize(cross(seed, n))
  if (isZero(u)) return { u: ZERO, v: ZERO }
  // v = n × u completes a right-handed frame: u × v = u × (n × u) = n(u·u) − u(u·n) = n.
  return { u, v: cross(n, u) }
}

/**
 * Project vertices into the plane, as a flat `[x0, y0, x1, y1, …]` array for earcut.
 *
 * The origin is the first vertex rather than the world origin. Site coordinates are sometimes
 * large — state-plane files put the building six figures from (0, 0) — and differencing first
 * keeps the doubles that reach earcut's area tests near the polygon's own scale.
 */
export function projectToPlane(vertices: readonly Vec3[], basis: PlaneBasis): number[] {
  const out: number[] = []
  const origin = vertices[0]
  if (origin === undefined) return out
  for (const p of vertices) {
    const dx = p.x - origin.x
    const dy = p.y - origin.y
    const dz = p.z - origin.z
    out.push(
      dx * basis.u.x + dy * basis.u.y + dz * basis.u.z,
      dx * basis.v.x + dy * basis.v.y + dz * basis.v.z,
    )
  }
  return out
}

/**
 * Triangulate a planar polygon. Returns indices into `vertices`, three per triangle.
 *
 * Degenerate input — fewer than three vertices, a zero-length normal, a coordinate that is
 * NaN — yields an empty array rather than a malformed mesh. A surface that cannot be drawn is
 * a validation finding (Phase 4), not a reason to hand the GPU a buffer full of NaN.
 *
 * Every triangle comes back wound counter-clockwise about `normal`, via `orientTriangles`.
 * earcut happens to emit counter-clockwise triangles already — see the note there — but that
 * is not part of its documented contract, and a face-orientation bug is invisible until
 * someone notices the building is lit from inside.
 */
export function triangulate(vertices: readonly Vec3[], normal: Vec3): Uint32Array {
  if (vertices.length < 3) return new Uint32Array(0)

  const basis = planeBasis(normal)
  if (isZero(basis.u)) return new Uint32Array(0)

  const flat = projectToPlane(vertices, basis)
  for (const c of flat) if (!Number.isFinite(c)) return new Uint32Array(0)

  return orientTriangles(flat, earcut(flat, undefined, 2))
}

/**
 * Force every triangle counter-clockwise in the projected frame, which — because the basis
 * is right-handed about the normal — means counter-clockwise about the normal in 3D.
 *
 * As of earcut 3.2 this is a no-op: earcut normalises the ring's winding internally and
 * always emits counter-clockwise triangles, whatever order the input ring arrived in.
 * `triangulate.test.ts` pins that upstream behaviour as a canary, and tests this function
 * directly on deliberately clockwise input, because the end-to-end path cannot reach the
 * flip and so cannot tell whether it works.
 */
export function orientTriangles(flat: readonly number[], indices: readonly number[]): Uint32Array {
  const out = new Uint32Array(indices.length - (indices.length % 3))
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!
    const b = indices[t + 1]!
    const c = indices[t + 2]!
    const flip = signedArea2d(flat, a, b, c) < 0
    out[t] = a
    out[t + 1] = flip ? c : b
    out[t + 2] = flip ? b : c
  }
  return out
}

/** Twice the signed area of a triangle in the projected frame. Positive means CCW. */
function signedArea2d(flat: readonly number[], a: number, b: number, c: number): number {
  const ax = flat[a * 2]!
  const ay = flat[a * 2 + 1]!
  const bx = flat[b * 2]!
  const by = flat[b * 2 + 1]!
  const cx = flat[c * 2]!
  const cy = flat[c * 2 + 1]!
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}
