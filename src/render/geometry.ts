/**
 * `ResolvedSurface` → three.js buffers.
 *
 * Coordinates stay in EnergyPlus's Z-up frame here and everywhere else. The single Z-up →
 * Y-up conversion lives on the scene root (`scene.ts`), per docs/03-idf-geometry.md §Units
 * and axes: every place we convert coordinates is a place an axis flip can leak back into
 * the file, so there is exactly one, at the display boundary.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import type { Vec3 } from '../model/index.js'
import type { ResolvedSurface } from '../geometry/index.js'

/**
 * Fenestration is coplanar with its base surface, which is a z-fighting tie the depth buffer
 * resolves differently every frame. v1 nudges it out along the base normal instead of doing
 * real CSG (docs/03-idf-geometry.md §Triangulation). 1 mm is far below anything a modeller
 * would notice and far above float32 depth precision at building scale.
 */
export const FENESTRATION_OFFSET = 0.001

/**
 * Triangle mesh for one surface.
 *
 * Normals are set to the surface's own Newell normal rather than computed per vertex. For a
 * planar polygon the two agree; for the slightly non-planar ones real files contain, the
 * Newell normal is the best-fit plane's and the per-vertex average is not, so this both
 * matches EnergyPlus's own view of the surface and shades flat, as a building surface should.
 *
 * `offset` displaces every vertex along `offsetDirection` — used for fenestration, and left
 * at zero for everything else.
 */
export function surfaceGeometry(
  surface: ResolvedSurface,
  offset = 0,
  offsetDirection: Vec3 = surface.normal,
): BufferGeometry {
  const verts = surface.worldVertices
  const positions = new Float32Array(verts.length * 3)
  const normals = new Float32Array(verts.length * 3)
  const dx = offsetDirection.x * offset
  const dy = offsetDirection.y * offset
  const dz = offsetDirection.z * offset

  verts.forEach((v, i) => {
    positions[i * 3] = v.x + dx
    positions[i * 3 + 1] = v.y + dy
    positions[i * 3 + 2] = v.z + dz
    normals[i * 3] = surface.normal.x
    normals[i * 3 + 1] = surface.normal.y
    normals[i * 3 + 2] = surface.normal.z
  })

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(new BufferAttribute(new Uint32Array(surface.triangles), 1))
  return geometry
}

/**
 * The surface outline, as `LineSegmentsGeometry` wants it: a flat run of segment endpoints,
 * `[ax, ay, az, bx, by, bz, …]`, closing the loop back to the first vertex.
 *
 * Drawn from the polygon ring, not from the triangulation, so a concave floor gets its actual
 * outline and not a web of interior diagonals. This is the difference between a drawing of a
 * building and a drawing of a mesh.
 */
export function surfaceEdgePositions(
  surface: ResolvedSurface,
  offset = 0,
  offsetDirection: Vec3 = surface.normal,
): number[] {
  const verts = surface.worldVertices
  if (verts.length < 2) return []
  const dx = offsetDirection.x * offset
  const dy = offsetDirection.y * offset
  const dz = offsetDirection.z * offset

  const out: number[] = []
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!
    const b = verts[(i + 1) % verts.length]!
    out.push(a.x + dx, a.y + dy, a.z + dz, b.x + dx, b.y + dy, b.z + dz)
  }
  return out
}
