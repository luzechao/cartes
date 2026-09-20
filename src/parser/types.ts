/**
 * Core IDF document types.
 *
 * Design constraint (see docs/04-architecture.md): the document must round-trip
 * byte-identically when nothing has been edited. This is achieved structurally rather
 * than by careful re-serialization — every object records the source span it came from,
 * and unmodified objects are emitted as verbatim slices of the original text.
 */

/** A single positional field within an IDF object. */
export interface IdfField {
  /** Value as written, with surrounding whitespace trimmed. Empty string for `,,`. */
  value: string
  /**
   * Trailing same-line comment following this field's delimiter, comment marker and
   * leading whitespace stripped. Conventionally the IDD field name, e.g. `- Surface Type`.
   * Decorative only — field identity comes from the IDD, never from this.
   */
  comment?: string
  /** Byte offset where this field's trimmed value starts in IdfDocument.source. */
  valueStart?: number | undefined
  /** Byte offset where this field's trimmed value ends in IdfDocument.source. */
  valueEnd?: number | undefined
}

export interface IdfObject {
  /** Synthetic, stable for the lifetime of the document. */
  id: string
  /** Class name exactly as written, e.g. `BuildingSurface:Detailed`. */
  className: string
  /** Lowercased class name, for case-insensitive lookup. */
  classKey: string
  /** Positional data fields, excluding the class name itself. */
  fields: IdfField[]
  /**
   * Source span `[start, end)` in `IdfDocument.source`, or `null` for objects created
   * after parsing. `end` is just past the terminating `;`.
   */
  start: number | null
  end: number | null
  /**
   * When false, the emitter reproduces the original source slice verbatim.
   * Objects with a null span are always treated as dirty.
   */
  dirty: boolean
  /** True when the object ran to EOF without a terminating `;`. */
  unterminated?: boolean
}

export interface IdfDiagnostic {
  severity: 'error' | 'warning'
  message: string
  offset: number
  objectId?: string
}

export interface IdfDocument {
  /** The original file text, retained verbatim. The basis of the round-trip guarantee. */
  source: string
  objects: Map<string, IdfObject>
  /** Object ids in emission order. Mutate this to reorder or delete. */
  order: string[]
  /** Lowercased class name → object ids, in document order. */
  byClass: Map<string, string[]>
  /** Value of the `Version` object's first field, if present. */
  version?: string
  diagnostics: IdfDiagnostic[]
}

export function getObject(doc: IdfDocument, id: string): IdfObject {
  const obj = doc.objects.get(id)
  if (!obj) throw new Error(`No such object: ${id}`)
  return obj
}

export function objectsOfClass(doc: IdfDocument, className: string): IdfObject[] {
  const ids = doc.byClass.get(className.toLowerCase()) ?? []
  return ids.map((id) => getObject(doc, id))
}
