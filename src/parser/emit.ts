import type { IdfDocument, IdfObject } from './types.js'

export interface EmitOptions {
  /** Spaces before each field on its own line. Only affects regenerated objects. */
  indent?: string
  /** Column at which `!-` comments are aligned. Only affects regenerated objects. */
  commentColumn?: number
}

const DEFAULTS: Required<EmitOptions> = { indent: '    ', commentColumn: 29 }

interface InferredFormatting {
  isSingleLine: boolean
  classPrefix: string
  indent: string
  commentColumn: number
}

function inferFormatting(raw: string): InferredFormatting {
  const isSingleLine = !raw.includes('\n')
  const lines = raw.split(/\r?\n/)

  const firstLine = lines[0] ?? ''
  const prefixMatch = /^(\s*)/.exec(firstLine)
  const classPrefix = prefixMatch ? prefixMatch[1]! : ''

  let indent = '    '
  for (let i = 1; i < lines.length; i++) {
    const m = /^(\s+)\S/.exec(lines[i]!)
    if (m) {
      indent = m[1]!
      break
    }
  }

  const commentCols: number[] = []
  for (const line of lines) {
    const idx = line.indexOf('!')
    if (idx > 0) {
      commentCols.push(idx)
    }
  }
  let commentColumn = 29
  if (commentCols.length > 0) {
    const counts = new Map<number, number>()
    for (const c of commentCols) {
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    let bestCol = commentCols[0]!
    let bestCount = 0
    for (const [col, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        bestCol = col
      }
    }
    commentColumn = bestCol
  }

  return { isSingleLine, classPrefix, indent, commentColumn }
}

/**
 * Try to surgically patch modified field values directly into the original source slice.
 * If every field that changed has a valid [valueStart, valueEnd] span, and the field count
 * is unchanged, this replaces exactly the edited values in place, preserving 100% of all
 * other lines, vertex groupings, spaces, and comments.
 */
function tryPatchOriginalSlice(
  obj: IdfObject,
  source: string,
): string | undefined {
  if (obj.start === null || obj.end === null) return undefined
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  for (const field of obj.fields) {
    if (field.valueStart === undefined || field.valueEnd === undefined) {
      return undefined
    }
    const origVal = source.slice(field.valueStart, field.valueEnd)
    if (origVal !== field.value) {
      edits.push({
        start: field.valueStart,
        end: field.valueEnd,
        replacement: field.value,
      })
    }
  }

  if (edits.length === 0) {
    return source.slice(obj.start, obj.end)
  }

  edits.sort((a, b) => a.start - b.start)

  let result = ''
  let cursor = obj.start
  for (const edit of edits) {
    if (edit.start < cursor) return undefined
    result += source.slice(cursor, edit.start)
    result += edit.replacement
    cursor = edit.end
  }
  result += source.slice(cursor, obj.end)
  return result
}

/**
 * Render an object from its structured fields. Used only for objects that are dirty or
 * were created after parsing — unmodified objects are emitted from their source slice.
 *
 * If `source` is provided and the object has a source span, formatting (indentation,
 * comment alignment column, leading class whitespace) is inferred from the original
 * slice to produce the smallest possible textual diff.
 */
export function renderObject(
  obj: IdfObject,
  options: EmitOptions = {},
  source?: string,
): string {
  if (source) {
    const patched = tryPatchOriginalSlice(obj, source)
    if (patched !== undefined) {
      return patched
    }
  }

  let inferred: InferredFormatting | undefined
  if (source && obj.start !== null && obj.end !== null) {
    inferred = inferFormatting(source.slice(obj.start, obj.end))
  }

  const classPrefix = inferred?.classPrefix ?? ''
  const indent = options.indent ?? inferred?.indent ?? DEFAULTS.indent
  const commentColumn = options.commentColumn ?? inferred?.commentColumn ?? DEFAULTS.commentColumn

  if (obj.fields.length === 0) {
    return `${classPrefix}${obj.className};\n`
  }

  // Preserve compact single-line objects (e.g. Version,26.2;)
  if (inferred?.isSingleLine && obj.fields.length <= 4) {
    const body = obj.fields
      .map((f, i) => `${f.value}${i === obj.fields.length - 1 ? ';' : ','}`)
      .join(rawIncludesSpaceAfterComma(source, obj.start!, obj.end!) ? ' ' : '')
    const lastField = obj.fields[obj.fields.length - 1]
    const comment = lastField?.comment ? `  !${lastField.comment}` : ''
    return `${classPrefix}${obj.className},${body.startsWith(' ') ? '' : ' '}${body}${comment}\n`
  }

  const out: string[] = []
  out.push(`${classPrefix}${obj.className},\n`)
  for (let i = 0; i < obj.fields.length; i++) {
    const field = obj.fields[i]!
    const isLast = i === obj.fields.length - 1
    const body = `${indent}${field.value}${isLast ? ';' : ','}`
    if (field.comment !== undefined && field.comment !== '') {
      const pad = body.length < commentColumn ? ' '.repeat(commentColumn - body.length) : '  '
      out.push(`${body}${pad}!${field.comment}\n`)
    } else {
      out.push(`${body}\n`)
    }
  }
  return out.join('')
}

function rawIncludesSpaceAfterComma(source: string | undefined, start: number, end: number): boolean {
  if (!source) return true
  const raw = source.slice(start, end)
  const firstComma = raw.indexOf(',')
  if (firstComma !== -1 && firstComma + 1 < raw.length) {
    return raw[firstComma + 1] === ' '
  }
  return true
}

/**
 * Serialize a document back to IDF text.
 *
 * Byte-identical to the input when no object is dirty: unmodified objects are emitted as
 * verbatim slices of the original source, and the text between objects (comments, blank
 * lines, BOM, trailing content) is carried through untouched.
 */
export function emitIdf(doc: IdfDocument, options: EmitOptions = {}): string {
  const out: string[] = []
  let cursor = 0

  for (const id of doc.order) {
    const obj = doc.objects.get(id)
    if (!obj) continue

    const hasSpan = obj.start !== null && obj.end !== null

    if (hasSpan) {
      // Emit the gap between the previous object and this one, verbatim.
      if (obj.start! > cursor) out.push(doc.source.slice(cursor, obj.start!))
      else if (obj.start! < cursor) {
        // Reordered relative to the source; the preceding gap has already been consumed.
      }
    }

    if (obj.dirty || !hasSpan) {
      out.push(renderObject(obj, options, doc.source))
    } else {
      out.push(doc.source.slice(obj.start!, obj.end!))
    }

    if (hasSpan) cursor = Math.max(cursor, obj.end!)
  }

  // Trailing gap: comments or whitespace after the final object.
  if (cursor < doc.source.length) out.push(doc.source.slice(cursor))

  return out.join('')
}
