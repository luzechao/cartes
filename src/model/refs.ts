/**
 * Reverse-reference index — Phase 6 of docs/05-implementation-plan.md.
 *
 * `names.ts` answers "what object is called X". This answers the opposite and much harder
 * question: "what names X", which is what deleting an object safely requires.
 *
 * Built from the IDD's `\object-list` metadata rather than a hardcoded class list. The plan's
 * hazard note names paired surfaces and child fenestration, but shipped models also point at
 * surfaces from `Daylighting:Controls`, `AirflowNetwork:MultiZone:Surface`, the
 * `SurfaceProperty:*` family, shading overhangs and output variables. Enumerating those by
 * hand would be wrong the moment a new EnergyPlus release adds one; reading the IDD is not.
 */
import type { IdfDocument } from '../parser/types.js'
import { fieldNameAt, fieldSpecAt, getSchema } from './idd.js'

export interface Reference {
  /** The object holding the reference. */
  fromId: string
  fromClassKey: string
  fieldIndex: number
  /** Resolved through the extensible group, so `Vertex 3 X-coordinate` rather than `Vertex 1`. */
  fieldName: string
  /** The `\object-list` groups this field points into, e.g. `["SurfaceNames"]`. Empty when undeclared. */
  objectList: readonly string[]
  /**
   * True when the IDD marks this field as pointing at another object.
   *
   * False means the field merely *contains* the name as text. See `byText`.
   */
  declared: boolean
  /** The referenced name, exactly as written in the referring field. */
  value: string
}

export interface ReferenceIndex {
  /** Lowercased referenced name → every reference the IDD declares via `\object-list`. */
  byName: ReadonlyMap<string, readonly Reference[]>
  /**
   * Lowercased name → fields that hold exactly that text but that the IDD does *not* declare
   * as references. Disjoint from `byName`.
   *
   * This exists because the IDD is an incomplete description of the dependencies in a file,
   * and because our IDD subset is an incomplete description of the IDD.
   *
   * Measured case: deleting surface `C1-1P` from `5ZoneAirCooled_AirBoundaries.idf` makes
   * EnergyPlus raise a severe error for two `Meter:Custom` objects that name it as a `Key
   * Name`. Two things hid it. `Key Name` carries no `\object-list`, because the pool of legal
   * key names depends on which output variables exist at runtime; and `Meter:Custom` is not in
   * the schema subset the model layer loads at all, so the whole object was skipped. A delete
   * would have looked safe and then failed in the simulation.
   *
   * A whole-field text match is a blunt instrument: a surface named `Roof` would match every
   * field whose value is `Roof`. So this is strictly advisory — reported to the user, never
   * acted on, and kept apart from `byName` so the two cannot be confused.
   */
  byText: ReadonlyMap<string, readonly Reference[]>
}

/**
 * Index every field that the IDD marks as pointing at another object by name.
 *
 * Keyed on the referenced *name* rather than on a resolved object id, because the two are not
 * the same thing: an `\object-list` group says which pool a field draws from, but the table
 * does not record which classes populate each pool, so a name cannot always be resolved to a
 * unique object.
 *
 * The consequence is over-reporting, never under-reporting: a schedule that happens to share
 * a surface's name shows up as a reference to that surface. For the job this index exists to
 * do — warning before a delete — a spurious warning is the safe direction and a missed
 * dangling pointer is not.
 */
export function buildReferenceIndex(doc: IdfDocument, version: string): ReferenceIndex {
  const byName = new Map<string, Reference[]>()
  const byText = new Map<string, Reference[]>()

  const push = (map: Map<string, Reference[]>, key: string, ref: Reference): void => {
    const list = map.get(key)
    if (list) list.push(ref)
    else map.set(key, [ref])
  }

  for (const id of doc.order) {
    const obj = doc.objects.get(id)
    if (!obj) continue

    // Deliberately *not* `if (!schema) continue`. The model layer loads a geometry-focused
    // subset of the IDD, so most of a real file's classes have no schema here — including
    // `Meter:Custom`, which was measured naming a surface and breaking a delete. Skipping
    // them would make this index silently blind to most of the file, which for a
    // delete-safety feature is the worst possible failure mode. Without a schema the
    // declared-reference half cannot run, but the textual half still can.
    const schema = getSchema(obj.classKey, version)

    for (let i = 0; i < obj.fields.length; i++) {
      const value = obj.fields[i]?.value
      if (value === undefined) continue
      const text = value.trim()
      if (text === '') continue

      const objectList = (schema ? fieldSpecAt(schema, i)?.objectList : undefined) ?? []
      const declared = objectList.length > 0

      // A purely numeric field cannot be naming anything, and skipping it keeps the advisory
      // index from matching a surface that someone called `1`.
      if (!declared && Number.isFinite(Number(text))) continue

      const ref: Reference = {
        fromId: id,
        fromClassKey: obj.classKey,
        fieldIndex: i,
        fieldName: (schema ? fieldNameAt(schema, i) : undefined) ?? `Field ${i + 1}`,
        objectList,
        declared,
        value: text,
      }
      push(declared ? byName : byText, text.toLowerCase(), ref)
    }
  }

  return { byName, byText }
}

/** Every IDD-declared reference to a name, excluding any held by the named object itself. */
export function referencesTo(
  index: ReferenceIndex,
  name: string,
  excludeId?: string,
): readonly Reference[] {
  const all = index.byName.get(name.trim().toLowerCase()) ?? []
  return excludeId === undefined ? all : all.filter((r) => r.fromId !== excludeId)
}

/**
 * Every field holding a name as plain text that the IDD does not declare as a reference.
 *
 * Advisory only — see `ReferenceIndex.byText` for why it exists and why it cannot be trusted
 * enough to act on.
 */
export function mentionsOf(
  index: ReferenceIndex,
  name: string,
  excludeId?: string,
): readonly Reference[] {
  const all = index.byText.get(name.trim().toLowerCase()) ?? []
  return excludeId === undefined ? all : all.filter((r) => r.fromId !== excludeId)
}
