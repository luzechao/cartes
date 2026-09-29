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
import { readSurfaceVertices, type Model } from './model.js'
import type { Surface } from './entities.js'
import { getSchema, fieldNameAt, readField } from './idd.js'
import { noteWrite, transact } from './history.js'

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
  return transact(doc, 'Edit field', () => writeField(doc, model, objectId, fieldIdx, newValue))
}

function writeField(
  doc: IdfDocument,
  model: Model,
  objectId: string,
  fieldIdx: number,
  newValue: string,
): boolean {
  const obj = doc.objects.get(objectId)
  if (!obj) return false
  // A blank write to an absent field is already true: IDF treats absent and blank alike.
  if ((obj.fields[fieldIdx]?.value ?? '') === newValue) return false
  noteWrite(doc, objectId)

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
 * Insert and/or remove whole fields inside an extensible group — the write path for adding or
 * deleting a vertex.
 *
 * `setFieldValue` cannot express this: it changes a value in place and the Phase 5 surgical
 * patcher relies on the field count never moving. A splice records the group layout on the
 * object so the emitter can re-render it by borrowing each new field's delimiter, line break
 * and comment from the same slot of a neighbouring group, rather than regenerating the object
 * from scratch. See `tryRenderSpliced` in `parser/emit.ts`.
 *
 * Deliberately does not touch the typed Model: which typed property a group of fields maps to
 * (vertices, for the only caller today) is the caller's knowledge, not this layer's.
 */
export function spliceFields(
  doc: IdfDocument,
  objectId: string,
  start: number,
  deleteCount: number,
  insert: readonly string[],
  layout: { beginIndex: number; stride: number },
): boolean {
  const obj = doc.objects.get(objectId)
  if (!obj) return false
  if (start < layout.beginIndex || start > obj.fields.length) return false
  if (deleteCount === 0 && insert.length === 0) return false

  return transact(doc, 'Edit vertices', () => {
    noteWrite(doc, objectId)
    obj.fields.splice(start, deleteCount, ...insert.map((value) => ({ value })))
    obj.extensible = { beginIndex: layout.beginIndex, stride: layout.stride }
    obj.dirty = true
    return true
  })
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
  return transact(doc, 'Revert object', () => revertOne(doc, model, objectId))
}

function revertOne(doc: IdfDocument, model: Model, objectId: string): boolean {
  const obj = doc.objects.get(objectId)
  if (!obj || !obj.dirty) return false
  if (obj.start === null || obj.end === null) return false

  const slice = doc.source.slice(obj.start, obj.end)
  const restoredDoc = parseIdf(slice)
  const restoredObj = restoredDoc.objects.values().next().value
  if (!restoredObj) return false

  noteWrite(doc, objectId)
  obj.fields = restoredObj.fields
  obj.dirty = false
  delete obj.extensible

  const surface = model.surfaces.get(objectId)
  const schema = getSchema(obj.classKey, model.version)
  if (surface && schema) {
    for (let i = 0; i < obj.fields.length; i++) {
      syncSurfaceProperty(surface, schema, i, obj.fields[i]!.value)
    }
    // Geometry edits (moves, and inserted or deleted vertices) live outside the scalar sync.
    surface.vertices = readSurfaceVertices(obj, schema)
    surface.declaredVertexCount = readField(obj, schema, 'Number of Vertices')
  }

  return true
}

/** Revert all dirty objects in the document back to their source state. */
export function revertAll(doc: IdfDocument, model: Model): number {
  return transact(doc, 'Revert all', () => {
    let count = 0
    for (const obj of doc.objects.values()) {
      if (obj.dirty) {
        if (revertOne(doc, model, obj.id)) count++
      }
    }
    return count
  })
}
