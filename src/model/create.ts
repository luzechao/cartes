/**
 * Creating objects — Phase 8 of docs/05-implementation-plan.md.
 *
 * The only way a new object enters a Document. It is added with no source span, which the
 * emitter already treats as "render from fields", and placed after the last object of its class
 * so a new wall lands among the walls rather than at the bottom of a 10,000-line file.
 *
 * Creation is recorded in the edit history like any other write: the pre-state is "did not
 * exist", so undo removes it and redo puts the same object back.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import { fieldNameAt, getSchema, resolveIddVersion } from './idd.js'
import { noteStructure, noteWrite, transact } from './history.js'

export interface CreateObjectOptions {
  /** Place directly after this object. Defaults to after the last object of the same class. */
  after?: string
  /** IDD release for field-name comments. Defaults to the one the Document's `Version` resolves to. */
  version?: string
}

function freshId(doc: IdfDocument): string {
  let n = doc.objects.size
  while (doc.objects.has(`n${n}`)) n++
  return `n${n}`
}

/**
 * Add a new object with the given field values and return its id.
 *
 * `className` is written as given; the IDD's canonical casing is used when the class is known.
 * Each field is commented with its IDD field name, as EnergyPlus's own examples are.
 */
export function createObject(
  doc: IdfDocument,
  className: string,
  values: readonly string[],
  { after, version = resolveIddVersion(doc.version).version }: CreateObjectOptions = {},
): string {
  return transact(doc, `Create ${className}`, () => {
    const classKey = className.toLowerCase()
    const schema = getSchema(classKey, version)
    const id = freshId(doc)
    const obj: IdfObject = {
      id,
      className: schema?.className ?? className,
      classKey,
      fields: values.map((value, i) => {
        const name = schema ? fieldNameAt(schema, i) : undefined
        return name ? { value, comment: `- ${name}` } : { value }
      }),
      start: null,
      end: null,
      dirty: true,
    }

    noteStructure(doc)
    noteWrite(doc, id, obj)

    const sameClass = doc.byClass.get(classKey) ?? []
    const anchor = after ?? sameClass[sameClass.length - 1]
    const at = anchor === undefined ? -1 : doc.order.indexOf(anchor)
    const position = at === -1 ? doc.order.length : at + 1
    doc.order.splice(position, 0, id)
    doc.objects.set(id, obj)

    // Keep `byClass` in document order, as the parser builds it.
    const rank = new Map(doc.order.map((x, i) => [x, i]))
    const list = [...sameClass, id].sort((a, b) => rank.get(a)! - rank.get(b)!)
    doc.byClass.set(classKey, list)
    return id
  })
}

/**
 * Field values for a class, filled by IDD field name.
 *
 * Unnamed fields between named ones are left blank, which EnergyPlus reads as "use the
 * default". Trailing blanks are trimmed, since `min-fields` is the IDD's business, not ours —
 * callers that need a field present name it.
 */
export function valuesByName(
  classKey: string,
  version: string,
  named: Readonly<Record<string, string>>,
): string[] {
  const schema = getSchema(classKey.toLowerCase(), version)
  if (!schema) throw new Error(`No IDD schema for ${classKey} at ${version}`)
  const values: string[] = []
  for (const [name, value] of Object.entries(named)) {
    const i = schema.index.get(name.toLowerCase())
    if (i === undefined) throw new Error(`${schema.className} has no field '${name}' at ${version}`)
    while (values.length <= i) values.push('')
    values[i] = value
  }
  return values
}
