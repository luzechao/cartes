/**
 * Drag gestures — the headless half of the Phase 6 viewport gizmo.
 *
 * The viewer turns a pointer into a ray; this turns a ray into an edit. Everything that decides
 * *what* a drag does lives here, in Node-testable code, and `render/viewer.ts` only draws the
 * handles and reports where the pointer is. That is the same boundary Phase 3 drew between
 * `scene.ts` and the viewer, for the same reason.
 *
 * Two gestures, because the Phase 6 gate measured that they are different operations:
 *
 *   - **vertex** — drag a vertex within its surface's plane. Every vertex coincident with it on
 *     a *coplanar* surface moves too: the interzone twin, and a coplanar neighbour sharing the
 *     corner. Those can follow without leaving their planes. A perpendicular neighbour cannot,
 *     so it is not dragged along — the validator and EnergyPlus will both say the zone is open,
 *     which is the truth about that edit.
 *   - **corner** — drag a building corner in plan. Everything on the vertical line through it
 *     moves horizontally (`planCornerMove`), which keeps every wall planar and the zone closed.
 *     Refused, with reasons, when `planCornerMove` says the corner is not coherent.
 *
 * Each update is absolute from the geometry at the start of the gesture, never incremental, so
 * a hundred pointer moves cannot accumulate rounding and snapping back onto the start position
 * restores the original bytes.
 */
import type { IdfDocument } from '../parser/types.js'
import type { Model, Vec3 } from '../model/index.js'
import {
  moveVertices,
  planCornerMove,
  verticesAt,
  type CornerMovePlan,
  type GeometryEditResult,
  type VertexRef,
} from './edit-geometry.js'
import { transformContext, type ResolvedSurface, type TransformContext } from './resolve.js'
import {
  buildSnapIndex,
  closestPointOnSegment,
  DEFAULT_SNAP_SETTINGS,
  planeOfSurface,
  projectOntoPlane,
  snapPoint,
  type Plane,
  type SnapIndex,
  type SnapResult,
  type SnapSettings,
} from './snap.js'

export type DragMode = 'vertex' | 'corner'

export interface Ray {
  origin: Vec3
  direction: Vec3
}

/**
 * Where a ray meets a plane, or undefined when it runs parallel to it or meets it behind the
 * origin. A grazing ray would put the point kilometres away; `minCos` refuses those too.
 */
export function intersectRayPlane(ray: Ray, plane: Plane, minCos = 1e-4): Vec3 | undefined {
  const n = plane.normal
  const d = ray.direction
  const len = Math.hypot(d.x, d.y, d.z)
  if (!(len > 0)) return undefined
  const denom = n.x * d.x + n.y * d.y + n.z * d.z
  if (Math.abs(denom) < minCos * len) return undefined
  const t = (plane.constant - (n.x * ray.origin.x + n.y * ray.origin.y + n.z * ray.origin.z)) / denom
  if (t < 0) return undefined
  return { x: ray.origin.x + d.x * t, y: ray.origin.y + d.y * t, z: ray.origin.z + d.z * t }
}

const COINCIDENT = 1e-6
const COPLANAR_COS = 1 - 1e-6

function coplanar(a: Plane, b: Plane, tol: number): boolean {
  const dot = a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z
  // Opposite normals are the same plane: an interzone twin faces the other way.
  if (Math.abs(dot) < COPLANAR_COS) return false
  return Math.abs(a.constant - Math.sign(dot) * b.constant) <= tol
}

export interface DragStart {
  mode: DragMode
  /** What will move. */
  members: VertexRef[]
  /** Where the grabbed vertex started, in world coordinates. */
  origin: Vec3
  /** The plane the drag is confined to. */
  plane: Plane
  /** For corner drags: the plan, so a refusal can say why. */
  cornerPlan?: CornerMovePlan
  /** Set when the gesture cannot start. Nothing is moved. */
  refused?: string
}

/**
 * Work out what dragging resolved vertex `resolvedIndex` of `surfaceId` would move, without
 * moving anything.
 */
export function planDrag(
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  surfaceId: string,
  resolvedIndex: number,
  mode: DragMode,
): DragStart | undefined {
  const r = resolved.get(surfaceId)
  const origin = r?.worldVertices[resolvedIndex]
  if (!r || !origin) return undefined

  if (mode === 'corner') {
    const plane: Plane = { normal: { x: 0, y: 0, z: 1 }, constant: origin.z }
    const plan = planCornerMove(model, resolved, origin.x, origin.y)
    const start: DragStart = { mode, members: plan.members, origin, plane, cornerPlan: plan }
    if (!plan.coherent) {
      const reasons = [
        ...plan.blocked.map((b) => `${model.surfaces.get(b.surfaceId)?.name ?? b.surfaceId} ${b.reason}`),
        ...(plan.subdividedEdges.length > 0
          ? [`${plan.subdividedEdges.length} incident edge(s) are subdivided by another surface's vertex`]
          : []),
      ]
      start.refused = reasons.length > 0 ? reasons.join('; ') : 'nothing to move at this corner'
    }
    return start
  }

  const plane = planeOfSurface(r)
  if (!plane) {
    return { mode, members: [], origin, plane: { normal: { x: 0, y: 0, z: 1 }, constant: origin.z }, refused: 'the surface is degenerate and has no plane to drag in' }
  }

  const members: VertexRef[] = []
  for (const ref of verticesAt(resolved, origin, COINCIDENT)) {
    if (ref.surfaceId === surfaceId) {
      members.push(ref)
      continue
    }
    const other = resolved.get(ref.surfaceId)
    const otherPlane = other && planeOfSurface(other)
    if (otherPlane && coplanar(plane, otherPlane, 1e-4)) members.push(ref)
  }
  return { mode, members, origin, plane }
}

export interface DragUpdate {
  /** Where the grabbed vertex now is. */
  point: Vec3
  snap: SnapResult
  result: GeometryEditResult
}

/**
 * A drag in progress. Construct at pointer-down, call `update` on each pointer move.
 *
 * Holds the geometry resolved at the start of the gesture: every update moves the members from
 * *there*, so updates are absolute. Undo grouping is the caller's: bracket the gesture with
 * `EditHistory.begin` / `end` and the whole drag is one step.
 */
export class DragSession {
  private readonly snapIndex: SnapIndex
  private readonly ctx: TransformContext

  constructor(
    private readonly doc: IdfDocument,
    private readonly model: Model,
    private readonly startGeometry: ReadonlyMap<string, ResolvedSurface>,
    readonly start: DragStart,
    readonly settings: SnapSettings = DEFAULT_SNAP_SETTINGS,
  ) {
    // Moving surfaces are left out of the index: their edges are about to be wherever the
    // pointer is, and snapping to where they *were* would pin the drag to its own wake.
    this.snapIndex = buildSnapIndex(startGeometry, { exclude: new Set(start.members.map((m) => m.surfaceId)) })
    this.ctx = transformContext(model)
  }

  /** Ids of every surface this drag moves. */
  get surfaceIds(): string[] {
    return [...new Set(this.start.members.map((m) => m.surfaceId))]
  }

  /** Move to wherever `ray` meets the drag plane. Undefined when it does not meet it usably. */
  updateFromRay(ray: Ray): DragUpdate | undefined {
    const hit = intersectRayPlane(ray, this.start.plane)
    return hit ? this.update(hit) : undefined
  }

  update(desired: Vec3): DragUpdate | undefined {
    if (this.start.refused || this.start.members.length === 0) return undefined
    const onPlane = projectOntoPlane(desired, this.start.plane)
    const snap = snapPoint(onPlane, this.snapIndex, this.settings, this.start.plane)
    const o = this.start.origin
    const delta = { x: snap.point.x - o.x, y: snap.point.y - o.y, z: snap.point.z - o.z }
    // Corner drags are plan-view by definition; the plane already guarantees it, this makes it
    // exact rather than 1e-16 close.
    if (this.start.mode === 'corner') delta.z = 0
    const result = moveVertices(this.doc, this.model, this.startGeometry, this.start.members, delta, this.ctx)
    return { point: { x: o.x + delta.x, y: o.y + delta.y, z: o.z + delta.z }, snap, result }
  }
}

export interface EdgeHit {
  /** Edge `i` runs from resolved vertex `i` to `i + 1`, wrapping — what `insertVertexWorld` takes. */
  edgeIndex: number
  point: Vec3
  distance: number
}

/** The edge of a surface nearest to a point, and the nearest point on it. */
export function nearestEdge(surface: ResolvedSurface, p: Vec3): EdgeHit | undefined {
  const vs = surface.worldVertices
  let best: EdgeHit | undefined
  for (let i = 0; i < vs.length; i++) {
    const point = closestPointOnSegment(p, vs[i]!, vs[(i + 1) % vs.length]!)
    const distance = Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z)
    if (!best || distance < best.distance) best = { edgeIndex: i, point, distance }
  }
  return best
}
