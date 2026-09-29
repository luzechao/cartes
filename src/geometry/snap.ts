/**
 * Snapping — Phase 6 of docs/05-implementation-plan.md.
 *
 * Grid, vertex and edge snapping, as pure functions over resolved world geometry. No three.js,
 * no pointer events: the viewport decides *where* the user is dragging, this decides where
 * that lands.
 *
 * Snapping is not a convenience here. The Phase 6 gate measured that moving one wall's corner
 * without moving the corner its neighbours share opens the zone enclosure, and EnergyPlus says
 * so (`CalculateZoneVolume: N zone is not fully enclosed`). Vertex snapping is what makes a
 * drag preserve the enclosure, so it is part of correctness rather than polish.
 */
import type { Vec3 } from '../model/index.js'
import type { ResolvedSurface } from './resolve.js'

export type SnapKind = 'vertex' | 'edge' | 'grid' | 'none'

export interface SnapTarget {
  point: Vec3
  surfaceId: string
  /** Index into the owning surface's resolved world vertices. */
  vertexIndex: number
}

export interface SnapEdge {
  a: Vec3
  b: Vec3
  surfaceId: string
  /** Edge `i` runs from resolved vertex `i` to vertex `i + 1`, wrapping. */
  edgeIndex: number
}

export interface SnapResult {
  point: Vec3
  kind: SnapKind
  /** Distance from the requested point to the snapped point, in metres. */
  distance: number
  /** The surface whose vertex or edge was snapped to, when `kind` is not `grid` or `none`. */
  surfaceId?: string
  vertexIndex?: number
  edgeIndex?: number
}

export interface SnapSettings {
  vertex: boolean
  edge: boolean
  grid: boolean
  /** Grid spacing in metres. */
  gridSize: number
  /** Maximum distance at which a snap engages, in metres. */
  tolerance: number
  /**
   * How far off the constraint plane a candidate may lie and still be considered.
   *
   * A wall's corner is shared with the adjoining wall, and that shared corner lies in *both*
   * planes. Filtering candidates by distance to the dragged surface's plane therefore keeps
   * exactly the corners worth snapping to and discards the ones that would break planarity.
   */
  planeTolerance: number
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  vertex: true,
  edge: true,
  grid: false,
  gridSize: 0.1,
  tolerance: 0.25,
  planeTolerance: 1e-3,
}

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** The plane of a resolved surface, as `normal . p = constant`. */
export interface Plane {
  normal: Vec3
  constant: number
}

export function planeOfSurface(surface: ResolvedSurface): Plane | undefined {
  const n = surface.normal
  if (n.x === 0 && n.y === 0 && n.z === 0) return undefined
  const c = surface.centroid
  return { normal: n, constant: n.x * c.x + n.y * c.y + n.z * c.z }
}

export function distanceToPlane(p: Vec3, plane: Plane): number {
  return Math.abs(p.x * plane.normal.x + p.y * plane.normal.y + p.z * plane.normal.z - plane.constant)
}

export function projectOntoPlane(p: Vec3, plane: Plane): Vec3 {
  const d = p.x * plane.normal.x + p.y * plane.normal.y + p.z * plane.normal.z - plane.constant
  return { x: p.x - d * plane.normal.x, y: p.y - d * plane.normal.y, z: p.z - d * plane.normal.z }
}

/** Closest point to `p` on the segment `a`–`b`, clamped to the endpoints. */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const lenSq = dx * dx + dy * dy + dz * dz
  if (lenSq === 0) return { ...a }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t }
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

/**
 * A uniform hash grid over snap candidates.
 *
 * Brute force would be O(vertices) per drag frame; the corpus has files with tens of
 * thousands of vertices, and a drag queries this on every pointer move. The grid makes a
 * query proportional to the number of candidates actually nearby.
 *
 * Edges are registered into every cell their bounding box touches, so a long wall edge is
 * found even when both of its endpoints are far from the cursor.
 */
export class SnapIndex {
  private readonly cellSize: number
  private readonly vertexCells = new Map<string, SnapTarget[]>()
  private readonly edgeCells = new Map<string, SnapEdge[]>()

  constructor(cellSize = 1) {
    this.cellSize = cellSize > 0 ? cellSize : 1
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)},${Math.floor(z / this.cellSize)}`
  }

  addVertex(target: SnapTarget): void {
    const k = this.key(target.point.x, target.point.y, target.point.z)
    const bucket = this.vertexCells.get(k)
    if (bucket) bucket.push(target)
    else this.vertexCells.set(k, [target])
  }

  addEdge(edge: SnapEdge): void {
    this.forEachCellInBox(
      Math.min(edge.a.x, edge.b.x),
      Math.min(edge.a.y, edge.b.y),
      Math.min(edge.a.z, edge.b.z),
      Math.max(edge.a.x, edge.b.x),
      Math.max(edge.a.y, edge.b.y),
      Math.max(edge.a.z, edge.b.z),
      (k) => {
        const bucket = this.edgeCells.get(k)
        if (bucket) bucket.push(edge)
        else this.edgeCells.set(k, [edge])
      },
    )
  }

  private forEachCellInBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    visit: (key: string) => void,
  ): void {
    const s = this.cellSize
    const ix0 = Math.floor(minX / s)
    const iy0 = Math.floor(minY / s)
    const iz0 = Math.floor(minZ / s)
    const ix1 = Math.floor(maxX / s)
    const iy1 = Math.floor(maxY / s)
    const iz1 = Math.floor(maxZ / s)

    // A degenerate model can produce a box spanning an absurd number of cells; cap the work
    // rather than hang the UI thread.
    const cells = (ix1 - ix0 + 1) * (iy1 - iy0 + 1) * (iz1 - iz0 + 1)
    if (!Number.isFinite(cells) || cells > 100_000) return

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          visit(`${ix},${iy},${iz}`)
        }
      }
    }
  }

  verticesNear(p: Vec3, radius: number): SnapTarget[] {
    const out: SnapTarget[] = []
    this.forEachCellInBox(
      p.x - radius,
      p.y - radius,
      p.z - radius,
      p.x + radius,
      p.y + radius,
      p.z + radius,
      (k) => {
        const bucket = this.vertexCells.get(k)
        if (bucket) out.push(...bucket)
      },
    )
    return out
  }

  edgesNear(p: Vec3, radius: number): SnapEdge[] {
    const seen = new Set<SnapEdge>()
    this.forEachCellInBox(
      p.x - radius,
      p.y - radius,
      p.z - radius,
      p.x + radius,
      p.y + radius,
      p.z + radius,
      (k) => {
        const bucket = this.edgeCells.get(k)
        if (bucket) for (const e of bucket) seen.add(e)
      },
    )
    return [...seen]
  }
}

export interface BuildSnapIndexOptions {
  /** Surface(s) to leave out — normally the ones being dragged. */
  exclude?: string | ReadonlySet<string>
  cellSize?: number
}

export function buildSnapIndex(
  resolved: ReadonlyMap<string, ResolvedSurface>,
  { exclude, cellSize = 1 }: BuildSnapIndexOptions = {},
): SnapIndex {
  const index = new SnapIndex(cellSize)
  const skip = (id: string): boolean =>
    exclude === undefined ? false : typeof exclude === 'string' ? id === exclude : exclude.has(id)
  for (const [id, surface] of resolved) {
    if (skip(id)) continue
    const vs = surface.worldVertices
    for (let i = 0; i < vs.length; i++) {
      index.addVertex({ point: vs[i]!, surfaceId: id, vertexIndex: i })
      if (vs.length >= 2) {
        index.addEdge({ a: vs[i]!, b: vs[(i + 1) % vs.length]!, surfaceId: id, edgeIndex: i })
      }
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

function snapToGrid(p: Vec3, size: number): Vec3 {
  if (!(size > 0)) return { ...p }
  return {
    x: Math.round(p.x / size) * size,
    y: Math.round(p.y / size) * size,
    z: Math.round(p.z / size) * size,
  }
}

/**
 * Resolve a desired world position to a snapped one.
 *
 * Priority is vertex, then edge, then grid — the CAD convention, and the right one here: a
 * vertex is a more specific commitment than a point somewhere along an edge, so a vertex
 * within tolerance wins even when an edge happens to be marginally closer.
 *
 * When `plane` is given, candidates further than `planeTolerance` from it are discarded and
 * the result is projected onto it. That is what keeps a snap from silently breaking the
 * surface's planarity, which EnergyPlus reports as a severe error.
 */
export function snapPoint(
  desired: Vec3,
  index: SnapIndex,
  settings: SnapSettings = DEFAULT_SNAP_SETTINGS,
  plane?: Plane,
): SnapResult {
  const admissible = (p: Vec3): boolean =>
    plane === undefined || distanceToPlane(p, plane) <= settings.planeTolerance

  const finish = (point: Vec3, kind: SnapKind, extra: Partial<SnapResult> = {}): SnapResult => {
    const snapped = plane ? projectOntoPlane(point, plane) : point
    return { point: snapped, kind, distance: distance(desired, snapped), ...extra }
  }

  if (settings.vertex) {
    let best: SnapTarget | undefined
    let bestDist = settings.tolerance
    for (const candidate of index.verticesNear(desired, settings.tolerance)) {
      if (!admissible(candidate.point)) continue
      const d = distance(desired, candidate.point)
      if (d <= bestDist) {
        bestDist = d
        best = candidate
      }
    }
    if (best) {
      return finish(best.point, 'vertex', {
        surfaceId: best.surfaceId,
        vertexIndex: best.vertexIndex,
      })
    }
  }

  if (settings.edge) {
    let bestPoint: Vec3 | undefined
    let bestEdge: SnapEdge | undefined
    let bestDist = settings.tolerance
    for (const edge of index.edgesNear(desired, settings.tolerance)) {
      const p = closestPointOnSegment(desired, edge.a, edge.b)
      if (!admissible(p)) continue
      const d = distance(desired, p)
      if (d <= bestDist) {
        bestDist = d
        bestPoint = p
        bestEdge = edge
      }
    }
    if (bestPoint && bestEdge) {
      return finish(bestPoint, 'edge', {
        surfaceId: bestEdge.surfaceId,
        edgeIndex: bestEdge.edgeIndex,
      })
    }
  }

  if (settings.grid) {
    const p = snapToGrid(desired, settings.gridSize)
    if (distance(desired, p) <= settings.tolerance && admissible(p)) {
      return finish(p, 'grid')
    }
  }

  return finish(desired, 'none')
}
