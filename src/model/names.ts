/**
 * Name index.
 *
 * IDF cross-references are by name and case-insensitive: a surface's `Zone Name` matches a
 * `Zone` whose `Name` differs only in casing. Original casing must survive to the emitter,
 * so the index maps lowercased names to object ids and never to strings.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import { getSchema } from './idd.js'

export interface DuplicateName {
  classKey: string
  /** As written on the first object to claim it. */
  name: string
  ids: string[]
}

export interface NameIndex {
  /** Lowercased name → ids, across every class. A name may be reused between classes. */
  byName: ReadonlyMap<string, readonly string[]>
  /** classKey → lowercased name → id. First declaration wins, matching EnergyPlus. */
  byClass: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** Same-class name collisions. EnergyPlus rejects these; we report and keep the first. */
  duplicates: readonly DuplicateName[]
}

/**
 * Build the index over every object whose class the IDD table knows and whose first field
 * is `Name`.
 *
 * Classes outside the table are skipped: without a schema we cannot tell a name from a
 * value, and guessing would make `Timestep, 4;` an object called "4". That is a real limit —
 * a reference into an unmodelled class will not resolve — but it is a *missing* answer
 * rather than a wrong one, which is the right failure direction here.
 */
export function buildNameIndex(doc: IdfDocument, version: string): NameIndex {
  const byName = new Map<string, string[]>()
  const byClass = new Map<string, Map<string, string>>()
  const duplicates: DuplicateName[] = []

  for (const id of doc.order) {
    const obj = doc.objects.get(id)
    if (!obj) continue
    const name = nameOf(obj, version)
    if (name === undefined || name === '') continue

    const key = name.toLowerCase()
    const list = byName.get(key)
    if (list) list.push(id)
    else byName.set(key, [id])

    let classMap = byClass.get(obj.classKey)
    if (!classMap) {
      classMap = new Map()
      byClass.set(obj.classKey, classMap)
    }
    const existing = classMap.get(key)
    if (existing === undefined) {
      classMap.set(key, id)
    } else {
      const dup = duplicates.find((d) => d.classKey === obj.classKey && d.name.toLowerCase() === key)
      if (dup) dup.ids.push(id)
      else duplicates.push({ classKey: obj.classKey, name, ids: [existing, id] })
    }
  }

  return { byName, byClass, duplicates }
}

/** The object's name as written, or undefined when the class has no `Name` field. */
export function nameOf(obj: IdfObject, version: string): string | undefined {
  const schema = getSchema(obj.classKey, version)
  if (!schema) return undefined
  if (schema.fields[0]?.name !== 'Name') return undefined
  return obj.fields[0]?.value
}

/** Resolve a reference within one class. */
export function lookupInClass(
  index: NameIndex,
  classKey: string,
  name: string,
): string | undefined {
  if (name === '') return undefined
  return index.byClass.get(classKey)?.get(name.toLowerCase())
}

/**
 * Resolve a reference that may land in any of several classes, in priority order.
 *
 * Surfaces are the reason this exists: a sub-surface's `Building Surface Name` may point at
 * `BuildingSurface:Detailed`, `Wall:Detailed`, `RoofCeiling:Detailed`, `Floor:Detailed` or
 * any Tier 3 rectangular class, and EnergyPlus resolves it against all of them at once.
 */
export function lookupIn(
  index: NameIndex,
  classKeys: readonly string[],
  name: string,
): string | undefined {
  if (name === '') return undefined
  const key = name.toLowerCase()
  for (const classKey of classKeys) {
    const id = index.byClass.get(classKey)?.get(key)
    if (id !== undefined) return id
  }
  return undefined
}

/** Every object claiming this name, in document order. Usually zero or one. */
export function lookupAnywhere(index: NameIndex, name: string): readonly string[] {
  if (name === '') return []
  return index.byName.get(name.toLowerCase()) ?? []
}
