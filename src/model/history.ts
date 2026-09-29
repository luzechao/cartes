/**
 * Undo and redo over Document-layer changes — Phase 6 of docs/05-implementation-plan.md.
 *
 * "Undo operates on Document-layer field changes." The Document is mutated in place — every
 * edit, from a construction-name change to a zone translate, ends in `setFieldValue`,
 * `spliceFields`, `revertObject` or an object removal. So the history records at exactly those
 * points: the first time a transaction touches an object, that object's pre-state (its fields,
 * dirty flag and splice layout) is captured; on commit, its post-state is too. Undo restores the
 * one, redo the other.
 *
 * This is deliberately *not* a snapshot store such as `zundo`. Snapshotting the Document would
 * mean copying every object on every drag frame, and snapshotting a reference would capture
 * objects that are then mutated underneath it. Capturing only what a transaction touches keeps
 * a vertex drag's undo entry to one object however large the file.
 *
 * Transactions nest by joining: every public edit operation opens one, so an inspector field
 * change is one undo step, a zone translate that writes forty vertices is one undo step, and a
 * drag gesture that the UI brackets with `begin`/`end` is one undo step however many moves it
 * made. With no history attached to a Document, all of this is a no-op.
 *
 * The typed Model is not restored here. It is derived; after `undo` or `redo`, rebuild it with
 * `buildModel`. A half-synchronised Model is worse than an honestly stale one — the same rule as
 * `applySurfaceDeletion`.
 */
import type { IdfDocument, IdfField, IdfObject } from '../parser/types.js'

interface ObjectState {
  exists: boolean
  obj: IdfObject
  fields: IdfField[]
  dirty: boolean
  extensible: IdfObject['extensible']
}

interface StructureState {
  order: string[]
  byClass: Array<[string, string[]]>
  deletedSpans: Array<{ start: number; end: number }> | undefined
}

interface Entry {
  label: string
  before: Map<string, ObjectState>
  after: Map<string, ObjectState>
  structureBefore?: StructureState
  structureAfter?: StructureState
}

export interface HistoryStep {
  label: string
  /** Ids of every object the step restored. Rebuild the Model after using these. */
  objectIds: string[]
}

const histories = new WeakMap<IdfDocument, EditHistory>()

function cloneFields(fields: readonly IdfField[]): IdfField[] {
  return fields.map((f) => ({ ...f }))
}

function captureObject(doc: IdfDocument, id: string, known?: IdfObject): ObjectState | undefined {
  const obj = doc.objects.get(id) ?? known
  if (!obj) return undefined
  return {
    exists: doc.objects.has(id),
    obj,
    fields: cloneFields(obj.fields),
    dirty: obj.dirty,
    extensible: obj.extensible ? { ...obj.extensible } : undefined,
  }
}

function captureStructure(doc: IdfDocument): StructureState {
  return {
    order: [...doc.order],
    byClass: [...doc.byClass].map(([k, ids]) => [k, [...ids]]),
    deletedSpans: doc.deletedSpans?.map((s) => ({ ...s })),
  }
}

function restoreObject(doc: IdfDocument, id: string, state: ObjectState): void {
  const obj = state.obj
  obj.fields = cloneFields(state.fields)
  obj.dirty = state.dirty
  if (state.extensible) obj.extensible = { ...state.extensible }
  else delete obj.extensible
  if (state.exists) doc.objects.set(id, obj)
  else doc.objects.delete(id)
}

/** Restore in place, so anything holding a reference to these containers stays valid. */
function restoreStructure(doc: IdfDocument, state: StructureState): void {
  doc.order.splice(0, doc.order.length, ...state.order)
  doc.byClass.clear()
  for (const [k, ids] of state.byClass) doc.byClass.set(k, [...ids])
  if (state.deletedSpans) doc.deletedSpans = state.deletedSpans.map((s) => ({ ...s }))
  else delete doc.deletedSpans
}

export class EditHistory {
  private readonly undoStack: Entry[] = []
  private readonly redoStack: Entry[] = []
  private open: Entry | undefined
  private depth = 0

  /**
   * @param limit Oldest steps are dropped beyond this many. Each step holds only the objects it
   *   touched, so the cost is proportional to what was edited, not to the file.
   */
  constructor(
    readonly doc: IdfDocument,
    readonly limit = 200,
  ) {
    histories.set(doc, this)
  }

  /** Stop recording. The Document keeps its current state. */
  detach(): void {
    if (histories.get(this.doc) === this) histories.delete(this.doc)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /** Number of steps `undo` can currently reverse. */
  get undoCount(): number {
    return this.undoStack.length
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Label of the step `undo` would reverse, for "Undo Move vertex" style menus. */
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }

  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  /** True between `begin` and the matching `end`. */
  get inTransaction(): boolean {
    return this.depth > 0
  }

  /** Open a transaction, or join the one already open. */
  begin(label: string): void {
    if (this.depth++ === 0) this.open = { label, before: new Map(), after: new Map() }
  }

  /** Close a transaction. The outermost `end` commits it as one undo step. */
  end(): void {
    if (this.depth === 0) return
    if (--this.depth > 0) return
    const entry = this.open
    this.open = undefined
    if (!entry || (entry.before.size === 0 && !entry.structureBefore)) return

    for (const [id, state] of entry.before) {
      const after = captureObject(this.doc, id, state.obj)
      if (after) entry.after.set(id, after)
    }
    if (entry.structureBefore) entry.structureAfter = captureStructure(this.doc)

    this.undoStack.push(entry)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
  }

  transact<T>(label: string, fn: () => T): T {
    this.begin(label)
    try {
      return fn()
    } finally {
      this.end()
    }
  }

  /** @internal Called by the write path before an object is changed. */
  noteWrite(id: string): void {
    const entry = this.open
    if (!entry || entry.before.has(id)) return
    const state = captureObject(this.doc, id)
    if (state) entry.before.set(id, state)
  }

  /** @internal Called by the write path before objects are added or removed. */
  noteStructure(): void {
    const entry = this.open
    if (!entry || entry.structureBefore) return
    entry.structureBefore = captureStructure(this.doc)
  }

  undo(): HistoryStep | undefined {
    if (this.depth > 0) return undefined
    const entry = this.undoStack.pop()
    if (!entry) return undefined
    if (entry.structureBefore) restoreStructure(this.doc, entry.structureBefore)
    for (const [id, state] of entry.before) restoreObject(this.doc, id, state)
    this.redoStack.push(entry)
    return { label: entry.label, objectIds: [...entry.before.keys()] }
  }

  redo(): HistoryStep | undefined {
    if (this.depth > 0) return undefined
    const entry = this.redoStack.pop()
    if (!entry) return undefined
    if (entry.structureAfter) restoreStructure(this.doc, entry.structureAfter)
    for (const [id, state] of entry.after) restoreObject(this.doc, id, state)
    this.undoStack.push(entry)
    return { label: entry.label, objectIds: [...entry.after.keys()] }
  }
}

/** The history recording this Document, if any. */
export function historyOf(doc: IdfDocument): EditHistory | undefined {
  return histories.get(doc)
}

/** Run `fn` as one undo step — or as part of the step already open. A no-op wrapper without a history. */
export function transact<T>(doc: IdfDocument, label: string, fn: () => T): T {
  const history = histories.get(doc)
  return history ? history.transact(label, fn) : fn()
}

/** @internal Record an object's state before the write path changes it. */
export function noteWrite(doc: IdfDocument, id: string): void {
  histories.get(doc)?.noteWrite(id)
}

/** @internal Record the Document's object list before an object is added or removed. */
export function noteStructure(doc: IdfDocument): void {
  histories.get(doc)?.noteStructure()
}
