/**
 * Surface deletion — Phase 6 of docs/05-implementation-plan.md.
 *
 * "Referential integrity is the hazard. Any edit touching a surface with
 * `Outside Boundary Condition = Surface` must either update the twin or flag the break. Never
 * leave a dangling `Outside Boundary Condition Object`."
 *
 * Deletion is split in two on purpose. `planSurfaceDeletion` computes and returns what would
 * happen; `applySurfaceDeletion` carries it out. The UI shows the plan first. This is the
 * "propose, never impose" discipline that `04-architecture.md` asks for in surface
 * auto-matching, applied here for the same reason: silently rewriting boundary conditions in
 * someone else's model is the fastest way to lose their trust.
 *
 * Note in particular what this does *not* do by default: it does not quietly convert an
 * orphaned twin to `Adiabatic`. That is VI-Suite's silent downgrade, which
 * `05-implementation-plan.md` explicitly rules out. The twin is left pointing at a surface
 * that no longer exists, the validator reports it as a dangling reference, and repairing it
 * is an action the user takes knowingly.
 */
import type { IdfDocument } from '../parser/types.js'
import type { Model } from './model.js'
import { getSchema, fieldIndex } from './idd.js'
import { referencesTo, mentionsOf, type Reference, type ReferenceIndex } from './refs.js'
import { setFieldValue } from './edit.js'
import { noteStructure, noteWrite, transact } from './history.js'

export interface CascadeEntry {
  id: string
  name: string
  className: string
  /** Why this object cannot outlive the surface. */
  reason: string
}

export interface TwinBreak {
  id: string
  name: string
  className: string
  fieldIndex: number
  fieldName: string
}

export interface DeletionPlan {
  surfaceId: string
  surfaceName: string
  className: string
  /** Objects deleted alongside the surface, because they cannot exist without it. */
  cascade: CascadeEntry[]
  /** Surfaces whose `Outside Boundary Condition Object` points at the surface being deleted. */
  twins: TwinBreak[]
  /**
   * Everything else in the file that names this surface. Reported so the user can see it;
   * never rewritten, because we cannot know what the right new value would be.
   */
  otherReferences: Reference[]
  /**
   * Fields holding the surface's name as plain text that the IDD does not declare as
   * references, so `otherReferences` cannot see them.
   *
   * Measured on `5ZoneAirCooled_AirBoundaries.idf`: deleting `C1-1P` with its twin repaired
   * still makes EnergyPlus raise two severe errors, because two `Meter:Custom` objects name
   * the surface as a `Key Name` — an undeclared field. Without this list the plan would claim
   * a clean delete and the simulation would disagree.
   *
   * Advisory and noisy by construction; see `ReferenceIndex.byText`.
   */
  undeclaredMentions: Reference[]
}

function displayName(doc: IdfDocument, id: string): { name: string; className: string } {
  const obj = doc.objects.get(id)
  return { name: obj?.fields[0]?.value ?? '', className: obj?.className ?? '' }
}

/**
 * Work out the full consequence of deleting a surface, without changing anything.
 *
 * Child fenestration and attached shading cascade: a `FenestrationSurface:Detailed` names its
 * base surface in a required field, so leaving it behind would produce a file EnergyPlus
 * rejects outright. Everything else is reported rather than rewritten.
 */
export function planSurfaceDeletion(
  doc: IdfDocument,
  model: Model,
  refs: ReferenceIndex,
  surfaceId: string,
): DeletionPlan | undefined {
  const surface = model.surfaces.get(surfaceId)
  if (!surface) return undefined

  const cascade: CascadeEntry[] = []
  const seen = new Set<string>([surfaceId])

  const addCascade = (id: string, reason: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const { name, className } = displayName(doc, id)
    cascade.push({ id, name, className, reason })
  }

  if (surface.kind === 'base') {
    for (const id of surface.subSurfaces) addCascade(id, 'names this surface as its base surface')
    for (const id of surface.attachedShading) addCascade(id, 'is shading attached to this surface')
  }
  if (surface.kind === 'sub') {
    for (const id of surface.attachedShading) addCascade(id, 'is shading attached to this surface')
  }

  // Sub-surfaces can themselves carry attached shading; pick that up transitively.
  for (const entry of [...cascade]) {
    const child = model.surfaces.get(entry.id)
    if (child && child.kind !== 'shading') {
      for (const id of child.attachedShading) {
        addCascade(id, `is shading attached to ${entry.name}`)
      }
    }
  }

  const twins: TwinBreak[] = []
  const otherReferences: Reference[] = []

  for (const ref of referencesTo(refs, surface.name, surfaceId)) {
    if (seen.has(ref.fromId)) continue

    const referrer = model.surfaces.get(ref.fromId)
    const isTwinPointer =
      referrer !== undefined &&
      /outside boundary condition object/i.test(ref.fieldName)

    if (isTwinPointer) {
      const { name, className } = displayName(doc, ref.fromId)
      twins.push({
        id: ref.fromId,
        name,
        className,
        fieldIndex: ref.fieldIndex,
        fieldName: ref.fieldName,
      })
    } else {
      otherReferences.push(ref)
    }
  }

  const undeclaredMentions = mentionsOf(refs, surface.name, surfaceId).filter(
    (ref) => !seen.has(ref.fromId),
  )

  return {
    surfaceId,
    surfaceName: surface.name,
    className: surface.className,
    cascade,
    twins,
    otherReferences,
    undeclaredMentions,
  }
}

export interface ApplyDeletionOptions {
  /**
   * What to do with a surface left pointing at the deleted one.
   *
   * - `leave` (default) — do nothing. The reference dangles and the validator says so. The
   *   user sees the break instead of the tool hiding it.
   * - `adiabatic` — rewrite the twin's boundary condition to `Adiabatic` and clear the
   *   pointer. Thermally this seals the surface, which is a real modelling decision, so it
   *   happens only when asked for by name.
   */
  twins?: 'leave' | 'adiabatic'
}

export interface DeletionResult {
  deleted: string[]
  repairedTwins: string[]
}

/**
 * Carry out a plan. Mutates the Document only.
 *
 * The caller must rebuild the Model afterwards. Deletion invalidates `surfaceOrder`,
 * `zoneOf`, and the `subSurfaces` / `attachedShading` back-pointers all at once, and a
 * half-synchronised Model is worse than an honestly stale one. `buildModel` is cheap.
 */
export function applySurfaceDeletion(
  doc: IdfDocument,
  model: Model,
  plan: DeletionPlan,
  options: ApplyDeletionOptions = {},
): DeletionResult {
  return transact(doc, 'Delete surface', () => applyDeletion(doc, model, plan, options))
}

function applyDeletion(
  doc: IdfDocument,
  model: Model,
  plan: DeletionPlan,
  { twins = 'leave' }: ApplyDeletionOptions,
): DeletionResult {
  const repairedTwins: string[] = []

  if (twins === 'adiabatic') {
    for (const twin of plan.twins) {
      const obj = doc.objects.get(twin.id)
      if (!obj) continue
      const schema = getSchema(obj.classKey, model.version)
      if (!schema) continue
      const bcIndex = fieldIndex(schema, 'Outside Boundary Condition')
      if (bcIndex === -1) continue

      setFieldValue(doc, model, twin.id, bcIndex, 'Adiabatic')
      setFieldValue(doc, model, twin.id, twin.fieldIndex, '')
      repairedTwins.push(twin.id)
    }
  }

  const toDelete = [plan.surfaceId, ...plan.cascade.map((c) => c.id)]
  const deleted: string[] = []
  for (const id of toDelete) {
    if (removeObject(doc, id)) deleted.push(id)
  }

  return { deleted, repairedTwins }
}

/**
 * Remove objects outright, with no referential checks — for callers that have already made the
 * references right, such as a conversion that replaces an object with an equivalent one of the
 * same name. One undo step. Returns the ids actually removed.
 */
export function removeObjects(doc: IdfDocument, ids: readonly string[]): string[] {
  return transact(doc, 'Remove objects', () => ids.filter((id) => removeObject(doc, id)))
}

/**
 * Remove an object from the document, recording its source span so the emitter skips it.
 *
 * The span is widened to swallow the run of blank space up to and including the newline that
 * terminated the object, so deleting an object does not leave a hole of blank lines behind.
 */
function removeObject(doc: IdfDocument, id: string): boolean {
  const obj = doc.objects.get(id)
  if (!obj) return false
  noteStructure(doc)
  noteWrite(doc, id)

  if (obj.start !== null && obj.end !== null) {
    let end = obj.end
    while (end < doc.source.length && (doc.source[end] === ' ' || doc.source[end] === '\t')) end++
    if (doc.source[end] === '\r') end++
    if (doc.source[end] === '\n') end++

    const spans = doc.deletedSpans ?? (doc.deletedSpans = [])
    spans.push({ start: obj.start, end })
    spans.sort((a, b) => a.start - b.start)
  }

  doc.objects.delete(id)
  const orderIdx = doc.order.indexOf(id)
  if (orderIdx !== -1) doc.order.splice(orderIdx, 1)

  const classList = doc.byClass.get(obj.classKey)
  if (classList) {
    const i = classList.indexOf(id)
    if (i !== -1) classList.splice(i, 1)
    if (classList.length === 0) doc.byClass.delete(obj.classKey)
  }

  return true
}
