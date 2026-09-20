/**
 * Model and document editing API — Phase 5 of docs/05-implementation-plan.md.
 *
 * Implements field-level writes from Layer 5 (UI) into Layer 1 (Document) and Layer 2 (Model).
 * Adheres to the core invariants of docs/04-architecture.md:
 * 1. Model -> Document writes are field-level: updating a property sets the specific field
 *    and marks the object dirty without rebuilding the object or touching other objects.
 * 2. Typed Model entities stay synchronized so that validation and rendering update in real time.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import { parseIdf } from '../parser/parse.js'
import type { Model } from './model.js'
import type { Surface } from './entities.js'
import { getSchema, fieldNameAt } from './idd.js'

export function getDirtyObjects(doc: IdfDocument): IdfObject[] {
  const dirty: IdfObject[] = []
  for (const obj of doc.objects.values()) {
    if (obj.dirty) dirty.push(obj)
  }
  return dirty
}

/**
 * Update a field on an IDF object, marking it dirty and synchronizing the typed Model.
 * Returns true if the value actually changed.
 */
export function setFieldValue(
  doc: IdfDocument,
  model: Model,
  objectId: string,
  fieldIdx: number,
  newValue: string,
): boolean {
  const obj = doc.objects.get(objectId)
  if (!obj) return false

  // Pad fields if fieldIdx exceeds current length
  while (obj.fields.length <= fieldIdx) {
    obj.fields.push({ value: '' })
  }

  const existing = obj.fields[fieldIdx]!
  if (existing.value === newValue) return false

  existing.value = newValue
  obj.dirty = true

  const schema = getSchema(obj.classKey, model.version)
  if (!existing.comment && schema) {
    const name = fieldNameAt(schema, fieldIdx)
    if (name) existing.comment = `- ${name}`
  }

  // Synchronize typed Model if this object represents a modeled surface
  const surface = model.surfaces.get(objectId)
  if (surface && schema) {
    syncSurfaceProperty(surface, schema, fieldIdx, newValue)
  }

  return true
}

function syncSurfaceProperty(
  surface: Surface,
  schema: import('./idd.js').ClassSchema,
  fieldIdx: number,
  value: string,
): void {
  const name = fieldNameAt(schema, fieldIdx)?.toLowerCase() ?? ''
  if (surface.kind === 'base') {
    if (name.includes('construction name')) {
      surface.constructionName = value
    } else if (name.includes('outside boundary condition object')) {
      surface.outsideBoundaryConditionObject = value
    } else if (name.includes('outside boundary condition')) {
      surface.outsideBoundaryCondition = value
    } else if (name.includes('sun exposure')) {
      surface.sunExposure = value
    } else if (name.includes('wind exposure')) {
      surface.windExposure = value
    } else if (name === 'surface type') {
      surface.surfaceType = value
    } else if (name === 'zone name') {
      surface.zoneName = value
    }
  } else if (surface.kind === 'sub') {
    if (name.includes('construction name')) {
      surface.constructionName = value
    } else if (name.includes('outside boundary condition object')) {
      surface.outsideBoundaryConditionObject = value
    } else if (name === 'surface type') {
      surface.surfaceType = value
    }
  }
}

/**
 * Revert a dirty object to its original text in doc.source.
 * Returns true if successfully reverted.
 */
export function revertObject(
  doc: IdfDocument,
  model: Model,
  objectId: string,
): boolean {
  const obj = doc.objects.get(objectId)
  if (!obj || !obj.dirty) return false
  if (obj.start === null || obj.end === null) return false

  const slice = doc.source.slice(obj.start, obj.end)
  const restoredDoc = parseIdf(slice)
  const restoredObj = restoredDoc.objects.values().next().value
  if (!restoredObj) return false

  obj.fields = restoredObj.fields
  obj.dirty = false

  const surface = model.surfaces.get(objectId)
  const schema = getSchema(obj.classKey, model.version)
  if (surface && schema) {
    for (let i = 0; i < obj.fields.length; i++) {
      syncSurfaceProperty(surface, schema, i, obj.fields[i]!.value)
    }
  }

  return true
}

/** Revert all dirty objects in the document back to their source state. */
export function revertAll(doc: IdfDocument, model: Model): number {
  let count = 0
  for (const obj of doc.objects.values()) {
    if (obj.dirty) {
      if (revertObject(doc, model, obj.id)) count++
    }
  }
  return count
}
