/**
 * Adding and deleting vertices — the part of Phase 6 that changes a surface's field *count*.
 *
 * Moving a vertex rewrites values in place and the Phase 5 surgical patcher handles it for
 * free. Inserting or removing one does not fit that model: it goes through `spliceFields`,
 * and the emitter re-renders the vertex block by borrowing each new line's formatting from its
 * neighbours (`tryRenderSpliced` in `parser/emit.ts`), so a three-per-line file stays
 * three-per-line and `Vertex N` comments are renumbered rather than left lying.
 *
 * Referential integrity: an interzone surface and its twin must keep the same vertex count, or
 * the validator reports `paired-vertex-mismatch` and EnergyPlus refuses the pair. By default the
 * same change is mirrored onto the twin, found by geometric coincidence. When the twin is drawn
 * offset from its partner (see `CornerMovePlan.splitPairs`) there is nothing coincident to
 * mirror onto, and the result says so instead of guessing.
 */
import type { IdfDocument } from '../parser/types.js'
import type { Model, Surface, Vec3 } from '../model/index.js'
import { getSchema, readField, setFieldValue, spliceFields, transact, vertexLayout } from '../model/index.js'
import { resolveSurface, transformContext, type TransformContext } from './resolve.js'
import { formatCoordinate, unresolveForSurface } from './unresolve.js'
import { surfaceNamed, type GeometryEditResult } from './edit-geometry.js'

export interface TwinOutcome {
  id: string
  name: string
  /** True when the twin received the corresponding change. */
  mirrored: boolean
  /** Why it did not, when it did not. */
  reason?: string
}

export interface VertexCountEditResult extends GeometryEditResult {
  /** Why nothing changed, when nothing did. */
  refused?: string
  /** The interzone twin, when the edited surface has one. */
  twin?: TwinOutcome
}

export interface VertexCountEditOptions {
  /**
   * `mirror` (the default) applies the same change to the interzone twin when one can be found
   * at the same position. `leave` edits only the named surface; the validator will then report
   * the pair's vertex counts as mismatched, which is sometimes the point (e.g. mid-way through
   * a manual repair).
   */
  twin?: 'mirror' | 'leave'
  ctx?: TransformContext
  /** Coincidence tolerance for finding the twin's corresponding edge or vertex, in metres. */
  tolerance?: number
}

const TWIN_TOLERANCE = 1e-6

/** The minimum a surface can keep: EnergyPlus rejects anything with fewer than three. */
const MIN_VERTICES = 3

function refuse(reason: string): VertexCountEditResult {
  return { changed: false, dirtied: [], refused: reason }
}

function near(a: Vec3, b: Vec3, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol
}

/** The surface on the other side of an interzone boundary, if any. */
function twinOf(model: Model, surface: Surface): Surface | undefined {
  let name: string
  if (surface.kind === 'base') {
    if (surface.outsideBoundaryCondition.trim().toLowerCase() !== 'surface') return undefined
    name = surface.outsideBoundaryConditionObject
  } else if (surface.kind === 'sub') {
    name = surface.outsideBoundaryConditionObject
  } else {
    return undefined
  }
  const twin = surfaceNamed(model, name)
  // A surface naming itself is a slab between identical zones; there is no second side.
  return twin && twin.id !== surface.id ? twin : undefined
}

interface Layout {
  beginIndex: number
  stride: number
  max: number
}

function layoutOf(model: Model, surface: Surface): Layout | undefined {
  const schema = getSchema(surface.classKey, model.version)
  return schema ? vertexLayout(schema) : undefined
}

/**
 * Keep `Number of Vertices` in step — but only when the file wrote a number there.
 *
 * `autocalculate` and blank both mean "count them", and stay that way: replacing them with a
 * literal would be a gratuitous change to a field the user never touched.
 */
function syncDeclaredCount(doc: IdfDocument, model: Model, surface: Surface): void {
  const schema = getSchema(surface.classKey, model.version)
  const obj = doc.objects.get(surface.id)
  if (!schema || !obj) return
  const index = schema.index.get('number of vertices')
  if (index === undefined) return
  const raw = readField(obj, schema, 'Number of Vertices').trim()
  if (raw === '' || !/^\d+$/.test(raw)) return
  const count = String(surface.vertices.length)
  if (Number(raw) === surface.vertices.length) return
  setFieldValue(doc, model, surface.id, index, count)
  surface.declaredVertexCount = count
}

/**
 * Where, in the file's own vertex order, a vertex inserted on resolved edge `i -> i+1` goes.
 *
 * Resolved order is a permutation of source order (entry direction, then starting corner), and
 * the two endpoints of any resolved edge are adjacent in the source ring too — just possibly
 * the other way round, for a Clockwise file. The new vertex goes between them. The seam between
 * the last and first source vertices is written as an append, which keeps vertex 1 — and with
 * it the starting corner — where it was.
 */
function sourceInsertPosition(sourceIndex: readonly number[], edgeStart: number): number {
  const n = sourceIndex.length
  const a = sourceIndex[edgeStart]!
  const b = sourceIndex[(edgeStart + 1) % n]!
  const forward = b === (a + 1) % n
  return (forward ? a : b) + 1
}

function insertOne(
  doc: IdfDocument,
  model: Model,
  surface: Surface,
  edgeStart: number,
  world: Vec3,
  ctx: TransformContext,
): VertexCountEditResult {
  const layout = layoutOf(model, surface)
  if (!layout) return refuse(`${surface.className} has no vertex fields`)
  const n = surface.vertices.length
  if (n < MIN_VERTICES) return refuse(`${surface.name} has fewer than ${MIN_VERTICES} vertices`)
  if (n + 1 > layout.max) {
    return refuse(
      `${surface.className} allows at most ${layout.max} vertices; EnergyPlus would reject a ` +
        `${n + 1}th`,
    )
  }
  if (!Number.isInteger(edgeStart) || edgeStart < 0 || edgeStart >= n) {
    return refuse(`edge ${edgeStart} does not exist on ${surface.name}`)
  }

  const resolved = resolveSurface(model, surface, ctx)
  const pos = sourceInsertPosition(resolved.sourceIndex, edgeStart)
  const local = unresolveForSurface(model, surface, ctx, world)
  const written = [local.x, local.y, local.z].map(formatCoordinate)

  const at = layout.beginIndex + pos * layout.stride
  if (!spliceFields(doc, surface.id, at, 0, written, layout)) {
    return refuse(`could not write vertex fields on ${surface.name}`)
  }
  surface.vertices.splice(pos, 0, {
    x: Number(written[0]),
    y: Number(written[1]),
    z: Number(written[2]),
  })
  syncDeclaredCount(doc, model, surface)
  return { changed: true, dirtied: [surface.id] }
}

function deleteOne(
  doc: IdfDocument,
  model: Model,
  surface: Surface,
  resolvedIndex: number,
  ctx: TransformContext,
): VertexCountEditResult {
  const layout = layoutOf(model, surface)
  if (!layout) return refuse(`${surface.className} has no vertex fields`)
  const n = surface.vertices.length
  if (n <= MIN_VERTICES) {
    return refuse(`${surface.name} has ${n} vertices; a surface needs at least ${MIN_VERTICES}`)
  }
  if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= n) {
    return refuse(`vertex ${resolvedIndex} does not exist on ${surface.name}`)
  }

  const resolved = resolveSurface(model, surface, ctx)
  const pos = resolved.sourceIndex[resolvedIndex]!
  const at = layout.beginIndex + pos * layout.stride
  if (!spliceFields(doc, surface.id, at, layout.stride, [], layout)) {
    return refuse(`could not remove vertex fields on ${surface.name}`)
  }
  surface.vertices.splice(pos, 1)
  syncDeclaredCount(doc, model, surface)
  return { changed: true, dirtied: [surface.id] }
}

function merge(primary: VertexCountEditResult, twin: TwinOutcome | undefined, extra: string[]): VertexCountEditResult {
  const dirtied = [...new Set([...primary.dirtied, ...extra])]
  const out: VertexCountEditResult = { changed: primary.changed, dirtied }
  if (twin) out.twin = twin
  return out
}

/**
 * Insert a vertex on the edge from resolved vertex `edgeStart` to the next one.
 *
 * Indices are in `ResolvedSurface.worldVertices` order, the order the viewport draws and picks
 * in. `world` is where the new vertex goes; it is not required to lie on the edge — splitting
 * an edge and immediately dragging the new point is one gesture, and forcing it through two
 * calls would put a transient collinear vertex in the undo history for no benefit.
 *
 * Refused, without change, beyond the class's vertex cap: `FenestrationSurface:Detailed`
 * cannot take a fifth vertex.
 */
export function insertVertexWorld(
  doc: IdfDocument,
  model: Model,
  surfaceId: string,
  edgeStart: number,
  world: Vec3,
  { twin: twinMode = 'mirror', ctx = transformContext(model), tolerance = TWIN_TOLERANCE }: VertexCountEditOptions = {},
): VertexCountEditResult {
  return transact(doc, 'Add vertex', () => {
    const surface = model.surfaces.get(surfaceId)
    if (!surface) return refuse(`no surface ${surfaceId}`)

    // Read the edge before anything moves, for finding the twin's copy of it.
    const before = resolveSurface(model, surface, ctx).worldVertices
    const n = before.length
    const a = before[edgeStart]
    const b = before[(edgeStart + 1) % n]

    const twin = twinOf(model, surface)
    // Check the twin can take the change before making it, so a pair is never left half-done by
    // a refusal on the second side.
    let twinEdge: number | undefined
    let twinReason: string | undefined
    if (twin && twinMode === 'mirror' && a && b) {
      const tv = resolveSurface(model, twin, ctx).worldVertices
      for (let k = 0; k < tv.length; k++) {
        const p = tv[k]!
        const q = tv[(k + 1) % tv.length]!
        if ((near(p, a, tolerance) && near(q, b, tolerance)) || (near(p, b, tolerance) && near(q, a, tolerance))) {
          twinEdge = k
          break
        }
      }
      if (twinEdge === undefined) {
        twinReason = 'the twin has no edge at the same position; it is drawn offset from this surface'
      } else {
        const twinLayout = layoutOf(model, twin)
        if (twinLayout && tv.length + 1 > twinLayout.max) {
          return refuse(`the twin ${twin.name} allows at most ${twinLayout.max} vertices`)
        }
      }
    }

    const primary = insertOne(doc, model, surface, edgeStart, world, ctx)
    if (!primary.changed) return primary
    if (!twin) return primary
    if (twinMode === 'leave') {
      return merge(primary, { id: twin.id, name: twin.name, mirrored: false, reason: 'left as asked' }, [])
    }
    if (twinEdge === undefined) {
      return merge(primary, { id: twin.id, name: twin.name, mirrored: false, reason: twinReason! }, [])
    }
    const mirrored = insertOne(doc, model, twin, twinEdge, world, ctx)
    return merge(
      primary,
      mirrored.changed
        ? { id: twin.id, name: twin.name, mirrored: true }
        : { id: twin.id, name: twin.name, mirrored: false, reason: mirrored.refused ?? 'unchanged' },
      mirrored.dirtied,
    )
  })
}

/**
 * Delete resolved vertex `resolvedIndex` from a surface.
 *
 * Refused, without change, when the surface would drop below three vertices. The twin loses its
 * vertex at the same world position, when it has one.
 */
export function deleteVertex(
  doc: IdfDocument,
  model: Model,
  surfaceId: string,
  resolvedIndex: number,
  { twin: twinMode = 'mirror', ctx = transformContext(model), tolerance = TWIN_TOLERANCE }: VertexCountEditOptions = {},
): VertexCountEditResult {
  return transact(doc, 'Delete vertex', () => {
    const surface = model.surfaces.get(surfaceId)
    if (!surface) return refuse(`no surface ${surfaceId}`)
    const target = resolveSurface(model, surface, ctx).worldVertices[resolvedIndex]

    const twin = twinOf(model, surface)
    let twinIndex: number | undefined
    let twinReason: string | undefined
    if (twin && twinMode === 'mirror' && target) {
      const tv = resolveSurface(model, twin, ctx).worldVertices
      twinIndex = tv.findIndex((p) => near(p, target, tolerance))
      if (twinIndex === -1) {
        twinIndex = undefined
        twinReason = 'the twin has no vertex at the same position; it is drawn offset from this surface'
      } else if (tv.length <= MIN_VERTICES) {
        return refuse(`the twin ${twin.name} has ${tv.length} vertices; a surface needs at least ${MIN_VERTICES}`)
      }
    }

    const primary = deleteOne(doc, model, surface, resolvedIndex, ctx)
    if (!primary.changed) return primary
    if (!twin) return primary
    if (twinMode === 'leave') {
      return merge(primary, { id: twin.id, name: twin.name, mirrored: false, reason: 'left as asked' }, [])
    }
    if (twinIndex === undefined) {
      return merge(primary, { id: twin.id, name: twin.name, mirrored: false, reason: twinReason! }, [])
    }
    const mirrored = deleteOne(doc, model, twin, twinIndex, ctx)
    return merge(
      primary,
      mirrored.changed
        ? { id: twin.id, name: twin.name, mirrored: true }
        : { id: twin.id, name: twin.name, mirrored: false, reason: mirrored.refused ?? 'unchanged' },
      mirrored.dirtied,
    )
  })
}
