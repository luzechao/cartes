/**
 * Geometry editing — Phase 6 of docs/05-implementation-plan.md.
 *
 * Every operation here funnels through `setFieldValue` from `model/edit.ts`, so a geometry
 * edit is the same kind of event as a construction-name edit: a field-level write that marks
 * exactly one object dirty and leaves every other byte of the file alone. That is what keeps
 * the Phase 1 round-trip guarantee intact while geometry changes.
 *
 * Lives in `geometry/` rather than `model/` because it depends on coordinate resolution;
 * putting it in `model/` would make the model layer depend on the layer above it.
 */
import type { IdfDocument } from '../parser/types.js'
import type { Model, Surface, Vec3 } from '../model/index.js'
import { setFieldValue } from '../model/edit.js'
import { transact } from '../model/history.js'
import { transformContext, type ResolvedSurface, type TransformContext } from './resolve.js'
import { formatCoordinate, unresolveForSurface, vertexFieldSlot } from './unresolve.js'

export interface GeometryEditResult {
  changed: boolean
  /** Ids of objects marked dirty by this edit. */
  dirtied: string[]
}

const UNCHANGED: GeometryEditResult = { changed: false, dirtied: [] }

/**
 * Move one vertex of a surface to a world-space position.
 *
 * `resolvedIndex` indexes `ResolvedSurface.worldVertices` — the order the viewport draws and
 * picks in — not the order the vertices appear in the file. `vertexFieldSlot` undoes both the
 * entry-direction reversal and the starting-corner rotation to find the fields to write.
 *
 * Does not enforce planarity, containment, or pairing. Those are the validator's job, and
 * running them here would mean an edit could be silently refused; the design is that any edit
 * is permitted and the validator immediately says what it broke.
 */
export function setVertexWorld(
  doc: IdfDocument,
  model: Model,
  surfaceId: string,
  resolvedIndex: number,
  world: Vec3,
  ctx: TransformContext = transformContext(model),
): GeometryEditResult {
  return transact(doc, 'Move vertex', () => {
    const surface = model.surfaces.get(surfaceId)
    if (!surface) return UNCHANGED

    const slot = vertexFieldSlot(model, surface, resolvedIndex)
    if (!slot) return UNCHANGED

    const local = unresolveForSurface(model, surface, ctx, world)
    return writeVertex(doc, model, surface, slot.sourceIndex, slot.fieldIndex, local)
  })
}

/**
 * Translate every vertex of a surface by a world-space delta.
 *
 * Because a rigid translation commutes with the rotations in the transform, this could be
 * done by rotating the delta once instead of unresolving each vertex. It is done the long way
 * on purpose: one code path for all vertex writes means one place for a sign error to hide,
 * and the corpus round-trip test covers it.
 */
export function translateSurface(
  doc: IdfDocument,
  model: Model,
  surfaceId: string,
  worldDelta: Vec3,
  resolvedWorldVertices: readonly Vec3[],
  ctx: TransformContext = transformContext(model),
): GeometryEditResult {
  return transact(doc, 'Move surface', () => {
    const surface = model.surfaces.get(surfaceId)
    if (!surface) return UNCHANGED

    let changed = false
    for (let i = 0; i < resolvedWorldVertices.length; i++) {
      const from = resolvedWorldVertices[i]!
      const moved = { x: from.x + worldDelta.x, y: from.y + worldDelta.y, z: from.z + worldDelta.z }
      const result = setVertexWorld(doc, model, surfaceId, i, moved, ctx)
      changed = changed || result.changed
    }
    return { changed, dirtied: changed ? [surfaceId] : [] }
  })
}

/**
 * Whether a field already holds this number, textually different though it may be.
 *
 * Files write zero as `0.0`, `0`, or `0.00000`, and a vertex drag that only moves Z must not
 * rewrite X and Y just because our formatter spells them differently. Comparing numerically
 * keeps the diff to the fields that genuinely moved — the same discipline as the Phase 5
 * surgical patcher, applied one level up.
 *
 * A blank field is never "already" a number, even though `Number('')` is 0.
 */
function alreadyHolds(current: string | undefined, value: number): boolean {
  if (current === undefined) return false
  const text = current.trim()
  if (text === '') return false
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return false
  return parsed === value
}

/**
 * Write a vertex in document coordinates, keeping the typed Model in step.
 *
 * `model/edit.ts`'s `syncSurfaceProperty` handles scalar fields only, so vertices are synced
 * here. Without this the viewport would keep drawing the old position until the next full
 * model rebuild.
 */
function writeVertex(
  doc: IdfDocument,
  model: Model,
  surface: Surface,
  sourceIndex: number,
  fieldIndex: number,
  local: Vec3,
): GeometryEditResult {
  const obj = doc.objects.get(surface.id)
  if (!obj) return UNCHANGED

  const components: Array<[number, number]> = [
    [fieldIndex, Number(formatCoordinate(local.x))],
    [fieldIndex + 1, Number(formatCoordinate(local.y))],
    [fieldIndex + 2, Number(formatCoordinate(local.z))],
  ]

  let changed = false
  for (const [index, value] of components) {
    if (alreadyHolds(obj.fields[index]?.value, value)) continue
    // Not `a || b || c`: `||` short-circuits, and every component must be considered.
    if (setFieldValue(doc, model, surface.id, index, formatCoordinate(value))) changed = true
  }

  if (!changed) return UNCHANGED

  const existing = surface.vertices[sourceIndex]
  if (existing) {
    // Hold exactly what the file now says, not the unrounded value, or the viewport and the
    // file disagree in the twelfth digit and a later round-trip check fails for no visible
    // reason.
    existing.x = components[0]![1]
    existing.y = components[1]![1]
    existing.z = components[2]![1]
  }

  return { changed: true, dirtied: [surface.id] }
}

// ---------------------------------------------------------------------------
// Moving a corner rather than a vertex
// ---------------------------------------------------------------------------

/** A vertex identified the way the viewport sees it: surface plus resolved index. */
export interface VertexRef {
  surfaceId: string
  resolvedIndex: number
}

const COINCIDENT_TOLERANCE = 1e-6

function sameXY(a: Vec3, x: number, y: number, tol: number): boolean {
  return Math.abs(a.x - x) <= tol && Math.abs(a.y - y) <= tol
}

/** Every vertex in the model at a given world point. */
export function verticesAt(
  resolved: ReadonlyMap<string, ResolvedSurface>,
  point: Vec3,
  tolerance = COINCIDENT_TOLERANCE,
): VertexRef[] {
  const out: VertexRef[] = []
  for (const [surfaceId, r] of resolved) {
    for (let i = 0; i < r.worldVertices.length; i++) {
      const v = r.worldVertices[i]!
      if (
        Math.abs(v.x - point.x) <= tolerance &&
        Math.abs(v.y - point.y) <= tolerance &&
        Math.abs(v.z - point.z) <= tolerance
      ) {
        out.push({ surfaceId, resolvedIndex: i })
      }
    }
  }
  return out
}

/**
 * Every vertex on the vertical line through a plan position — a building corner as seen from
 * above.
 *
 * This is the set a corner drag in plan view must move: the top and bottom of each wall's
 * vertical edge, the floor and ceiling corners meeting it, and the matching vertices of any
 * interzone twin. Moving only the picked vertex tears the zone open, which EnergyPlus reports
 * as `CalculateZoneVolume: N zone is not fully enclosed`.
 */
export function verticesOnVerticalEdge(
  resolved: ReadonlyMap<string, ResolvedSurface>,
  x: number,
  y: number,
  tolerance = COINCIDENT_TOLERANCE,
): VertexRef[] {
  const out: VertexRef[] = []
  for (const [surfaceId, r] of resolved) {
    for (let i = 0; i < r.worldVertices.length; i++) {
      if (sameXY(r.worldVertices[i]!, x, y, tolerance)) out.push({ surfaceId, resolvedIndex: i })
    }
  }
  return out
}

/**
 * Is some other surface's vertex sitting part-way along this edge?
 *
 * Measured on `PurchAirWithDaylighting.idf`: a zone's south face is two collinear walls
 * meeting at an intermediate point, while the floor and roof span the whole run as a single
 * edge. Moving the far corner bends the floor edge, and the intermediate vertex — which
 * belongs to the two walls but not to the floor — stops lying on it. EnergyPlus then reports
 * the zone as no longer enclosed, correctly.
 *
 * So vertex coincidence is not a sufficient precondition for a corner move. The incident
 * edges must also be unsubdivided.
 */
export function edgeIsSubdivided(
  a: Vec3,
  b: Vec3,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  tolerance = COINCIDENT_TOLERANCE,
): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const lenSq = dx * dx + dy * dy + dz * dz
  if (lenSq === 0) return false

  for (const r of resolved.values()) {
    for (const v of r.worldVertices) {
      const t = ((v.x - a.x) * dx + (v.y - a.y) * dy + (v.z - a.z) * dz) / lenSq
      if (t <= tolerance || t >= 1 - tolerance) continue // an endpoint, not a subdivision
      const px = a.x + dx * t
      const py = a.y + dy * t
      const pz = a.z + dz * t
      if (Math.hypot(v.x - px, v.y - py, v.z - pz) <= tolerance) return true
    }
  }
  return false
}

export interface SplitPair {
  surfaceId: string
  surfaceName: string
  twinId: string
  twinName: string
}

export interface CornerMovePlan {
  /** The vertices that would move. */
  members: VertexRef[]
  /**
   * Surfaces sharing the corner that the move would leave behind, with the reason. Non-empty
   * means the move tears the model rather than translating it.
   */
  blocked: Array<{ surfaceId: string; reason: string }>
  /** Edges incident to the corner that another surface's vertex subdivides. */
  subdividedEdges: Array<{ surfaceId: string; resolvedIndex: number }>
  /**
   * Surfaces in the move whose interzone twin is *not* also in the move.
   *
   * A named pair is not necessarily a coincident one. Measured on `Plenum.idf`, whose zones
   * are drawn at their inside faces with the partition thickness between them: `Zn001:Wall004`
   * sits at x = 30.700 and its twin `Zn002:Wall004` at x = 30.730, a 30 mm offset, with a
   * further 20 mm in y. EnergyPlus accepts that — it matches interzone surfaces by name and
   * area, not by coordinates — so it is a legitimate and not especially rare way to model.
   *
   * The consequence is that plan-view coincidence, which is what gathers `members`, picks up
   * one side of such a pair and not the other, and the two faces end up with different areas.
   *
   * Reported rather than refused, and deliberately *not* part of `coherent`. The first version
   * of this did veto the move, and measurement said that was wrong twice over: it left
   * `Plenum.idf` with no movable corner at all, and forcing the move anyway produced no
   * complaint from EnergyPlus whatsoever at 50 mm or 250 mm. The divergence only exceeds
   * EnergyPlus's own interzone tolerance around 1 m, where it becomes
   * `GetSurfaceData: InterZone Surface Areas do not match as expected`. Blocking a drag the
   * simulation is content with would be the tool imposing a rule of its own invention.
   *
   * Moving the twin as well means matching its corresponding corner by proximity rather than
   * equality, which is the Phase 7 auto-matching problem. Until then the caller is told, and
   * decides.
   */
  splitPairs: SplitPair[]
  /** True when the move is safe to apply as-is. */
  coherent: boolean
}

export interface PlanCornerMoveOptions {
  tolerance?: number
  /**
   * Treat surfaces carrying fenestration as immovable.
   *
   * Shifting a wall can push a window outside the new perimeter, which EnergyPlus reports as a
   * severe error. Until containment-aware editing exists, refusing is better than producing a
   * file the simulation rejects.
   */
  excludeFenestrated?: boolean
}

/**
 * Work out whether a plan-view corner can be moved coherently, without changing anything.
 *
 * Propose-then-apply, the same discipline as `model/delete.ts`: the caller sees what would
 * move, what would be left behind, and why, before committing.
 */
export function planCornerMove(
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  x: number,
  y: number,
  { tolerance = COINCIDENT_TOLERANCE, excludeFenestrated = true }: PlanCornerMoveOptions = {},
): CornerMovePlan {
  const members: VertexRef[] = []
  const blocked: Array<{ surfaceId: string; reason: string }> = []

  for (const [surfaceId, r] of resolved) {
    const surface = model.surfaces.get(surfaceId)
    if (!surface) continue

    const hits: number[] = []
    for (let i = 0; i < r.worldVertices.length; i++) {
      if (sameXY(r.worldVertices[i]!, x, y, tolerance)) hits.push(i)
    }
    if (hits.length === 0) continue

    const carriesFenestration =
      surface.kind === 'base' &&
      (surface.subSurfaces.length > 0 || surface.attachedShading.length > 0)

    if (excludeFenestrated && carriesFenestration) {
      blocked.push({
        surfaceId,
        reason: 'carries fenestration or attached shading, which moving the wall could orphan',
      })
      continue
    }
    if (surface.kind === 'sub') {
      blocked.push({ surfaceId, reason: 'is a sub-surface; move its base surface instead' })
      continue
    }

    for (const i of hits) members.push({ surfaceId, resolvedIndex: i })
  }

  const subdividedEdges: Array<{ surfaceId: string; resolvedIndex: number }> = []
  for (const ref of members) {
    const vs = resolved.get(ref.surfaceId)!.worldVertices
    const n = vs.length
    if (n < 2) continue
    const here = vs[ref.resolvedIndex]!
    const prev = vs[(ref.resolvedIndex - 1 + n) % n]!
    const next = vs[(ref.resolvedIndex + 1) % n]!
    if (
      edgeIsSubdivided(here, next, resolved, tolerance) ||
      edgeIsSubdivided(prev, here, resolved, tolerance)
    ) {
      subdividedEdges.push(ref)
    }
  }

  const moving = new Set(members.map((m) => m.surfaceId))
  const splitPairs: SplitPair[] = []
  for (const surfaceId of moving) {
    const surface = model.surfaces.get(surfaceId)
    if (!surface || surface.kind !== 'base') continue
    if (surface.outsideBoundaryCondition.trim().toLowerCase() !== 'surface') continue

    const twin = surfaceNamed(model, surface.outsideBoundaryConditionObject)
    // A missing twin is a dangling reference, which the validator already reports; it is not
    // this operation's business. A surface naming itself has no separate side to keep in step.
    if (!twin || twin.id === surfaceId) continue
    if (moving.has(twin.id)) continue

    splitPairs.push({
      surfaceId,
      surfaceName: surface.name,
      twinId: twin.id,
      twinName: twin.name,
    })
  }

  return {
    members,
    blocked,
    subdividedEdges,
    splitPairs,
    // `splitPairs` is deliberately absent: see its documentation above.
    coherent: members.length > 0 && blocked.length === 0 && subdividedEdges.length === 0,
  }
}

/**
 * Resolve a surface by name.
 *
 * Linear rather than indexed: a corner move runs once per drag, not per frame, and an index
 * built here would be one more thing to invalidate when a surface is renamed.
 */
export function surfaceNamed(model: Model, name: string): Surface | undefined {
  const wanted = name.trim().toLowerCase()
  if (wanted === '') return undefined
  for (const s of model.surfaces.values()) {
    if (s.name.trim().toLowerCase() === wanted) return s
  }
  return undefined
}

/**
 * Translate a set of vertices by one world delta.
 *
 * Positions are read from `resolved` rather than recomputed as each write lands, so every
 * member moves relative to the same starting geometry. Reading them back one at a time would
 * compound: moving surface A changes nothing about B's resolved vertices, but re-resolving
 * mid-loop would mean later members were measured against an already-edited model.
 */
export function moveVertices(
  doc: IdfDocument,
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  members: readonly VertexRef[],
  worldDelta: Vec3,
  ctx: TransformContext = transformContext(model),
): GeometryEditResult {
  return transact(doc, 'Move corner', () => {
    const dirtied = new Set<string>()

    for (const { surfaceId, resolvedIndex } of members) {
      const from = resolved.get(surfaceId)?.worldVertices[resolvedIndex]
      if (!from) continue
      const result = setVertexWorld(
        doc,
        model,
        surfaceId,
        resolvedIndex,
        { x: from.x + worldDelta.x, y: from.y + worldDelta.y, z: from.z + worldDelta.z },
        ctx,
      )
      for (const id of result.dirtied) dirtied.add(id)
    }

    return { changed: dirtied.size > 0, dirtied: [...dirtied] }
  })
}
