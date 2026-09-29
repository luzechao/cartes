import type { IdfDocument, IdfObject } from './types.js'
import { parseIdf } from './parse.js'

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
 * If every field that changed has a valid [valueStart, valueEnd] span, this replaces exactly the
 * edited values in place, preserving 100% of all other lines, vertex groupings, spaces, and
 * comments.
 *
 * It cannot see a *removed* field — every survivor still matches its own span — so it must only
 * be used on objects whose shape is the parsed one. `renderObject` guarantees that for spliced
 * objects; a field-count change by any other route adds span-less fields, which bail here.
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

/** Spans of the object's fields as originally parsed, in absolute source offsets. */
function originalFieldSpans(
  obj: IdfObject,
  source: string,
): Array<{ valueStart: number; valueEnd: number }> | undefined {
  if (obj.start === null || obj.end === null) return undefined
  const reparsed = parseIdf(source.slice(obj.start, obj.end)).objects.values().next().value
  if (!reparsed) return undefined
  const spans: Array<{ valueStart: number; valueEnd: number }> = []
  for (const f of reparsed.fields) {
    if (f.valueStart === undefined || f.valueEnd === undefined) return undefined
    spans.push({ valueStart: f.valueStart + obj.start, valueEnd: f.valueEnd + obj.start })
  }
  return spans
}

function sameShapeAsSource(obj: IdfObject, source: string): boolean {
  const original = originalFieldSpans(obj, source)
  return original !== undefined && hasOriginalShape(obj, original)
}

/** True when the object still holds exactly its parsed fields, in their parsed order. */
function hasOriginalShape(
  obj: IdfObject,
  original: ReadonlyArray<{ valueStart: number }>,
): boolean {
  if (obj.fields.length !== original.length) return false
  return obj.fields.every((f, i) => f.valueStart === original[i]!.valueStart)
}

/**
 * Replace the group number in a borrowed or relocated comment.
 *
 * `!- X,Y,Z ==> Vertex 3 {m}` must not survive as `Vertex 3` once a vertex has been inserted
 * before it. Only the exact number the comment was written with is touched, and only as a
 * whole word, so a comment that happens to hold some other number is left alone.
 */
function renumberGap(gap: string, fromGroup: number | undefined, toGroup: number | undefined): string {
  if (fromGroup === undefined || toGroup === undefined || fromGroup === toGroup) return gap
  const bang = gap.indexOf('!')
  if (bang === -1) return gap
  const pattern = new RegExp(`\\b${fromGroup}\\b`)
  return gap.slice(0, bang) + gap.slice(bang).replace(pattern, String(toGroup))
}

/**
 * Keep a column-aligned `!-` comment in its column when the value before it changes width.
 *
 * Only for gaps whose author visibly aligned them — more than two spaces before the `!`.
 * Three-per-line vertex rows (`0,0,3,  !- X,Y,Z ==> Vertex 1 {m}`) use a fixed two-space
 * separator instead, and padding those out would invent an alignment the file never had.
 */
function realignGap(gap: string, widthWas: number, widthNow: number): string {
  if (widthWas === widthNow) return gap
  const m = /^([,;])( +)!/.exec(gap)
  if (!m || m[2]!.length <= 2) return gap
  const spaces = Math.max(2, m[2]!.length - (widthNow - widthWas))
  return m[1]! + ' '.repeat(spaces) + gap.slice(1 + m[2]!.length)
}

/**
 * Re-render an object whose field *count* has changed — a vertex inserted or deleted —
 * without regenerating it from scratch.
 *
 * The original slice is decomposed into the class-name prefix, each field's value, the
 * verbatim text *after* each field (delimiter, spacing, comment, line break, indentation), and
 * the tail following the last field (`;` plus its comment). Surviving fields keep their own
 * trailing text; a field that gained a successor borrows the trailing text of the same slot
 * one group earlier (or later), which is what makes an inserted vertex land on its own line in
 * a three-per-line file and on three lines in a one-per-line file. Group-numbered comments are
 * renumbered to their new position.
 *
 * Returns undefined when the object cannot be decomposed this way, and the caller falls back
 * to a full regeneration from structured fields.
 */
function tryRenderSpliced(obj: IdfObject, source: string): string | undefined {
  const layout = obj.extensible
  if (!layout || obj.start === null || obj.end === null || obj.fields.length === 0) return undefined
  const original = originalFieldSpans(obj, source)
  if (!original || original.length === 0) return undefined
  if (hasOriginalShape(obj, original)) return undefined

  const origIndexByStart = new Map<number, number>()
  original.forEach((s, j) => origIndexByStart.set(s.valueStart, j))
  const origOf = obj.fields.map((f) =>
    f.valueStart === undefined ? undefined : origIndexByStart.get(f.valueStart),
  )
  if (origOf[0] !== 0) return undefined

  const lastOrig = original.length - 1
  const trailing = (j: number): string =>
    source.slice(original[j]!.valueEnd, original[j + 1]!.valueStart)
  const groupOf = (i: number): number | undefined =>
    i < layout.beginIndex ? undefined : Math.floor((i - layout.beginIndex) / layout.stride) + 1

  /** Trailing text for output field `i`, as (text, original index it was written for). */
  const commaGap = (i: number): [string, number] | undefined => {
    const own = origOf[i]
    if (own !== undefined && own < lastOrig) return [trailing(own), own]
    for (const step of [-layout.stride, layout.stride]) {
      for (let k = i + step; k >= 0 && k < obj.fields.length; k += step) {
        const j = origOf[k]
        if (j !== undefined && j < lastOrig) return [trailing(j), j]
      }
    }
    return undefined
  }

  let out = source.slice(obj.start, original[0]!.valueStart)
  const last = obj.fields.length - 1
  const widthOf = (j: number): number => original[j]!.valueEnd - original[j]!.valueStart
  for (let i = 0; i <= last; i++) {
    const value = obj.fields[i]!.value
    out += value
    if (i === last) {
      const tail = source.slice(original[lastOrig]!.valueEnd, obj.end)
      out += realignGap(renumberGap(tail, groupOf(lastOrig), groupOf(i)), widthOf(lastOrig), value.length)
    } else {
      const gap = commaGap(i)
      if (!gap) return undefined
      out += realignGap(renumberGap(gap[0], groupOf(gap[1]), groupOf(i)), widthOf(gap[1]), value.length)
    }
  }
  return out
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
    const spliced = tryRenderSpliced(obj, source)
    if (spliced !== undefined) return spliced
    // A splice whose shape could not be decomposed must not reach the in-place patcher: with a
    // field removed, every survivor still matches its own span, and the patcher would hand back
    // the original slice with the removed values still in it.
    const reshaped = obj.extensible !== undefined && !sameShapeAsSource(obj, source)
    const patched = reshaped ? undefined : tryPatchOriginalSlice(obj, source)
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
 * Emit the untouched text between objects, minus any spans belonging to deleted objects.
 *
 * With nothing deleted this is a plain slice, which is what keeps the Phase 1 byte-identical
 * round trip intact.
 */
function gapText(doc: IdfDocument, from: number, to: number): string {
  const spans = doc.deletedSpans
  if (!spans || spans.length === 0 || from >= to) return doc.source.slice(from, to)

  let out = ''
  let cursor = from
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.end <= cursor || span.start >= to) continue
    const skipFrom = Math.max(span.start, cursor)
    if (skipFrom > cursor) out += doc.source.slice(cursor, skipFrom)
    cursor = Math.min(span.end, to)
  }
  if (cursor < to) out += doc.source.slice(cursor, to)
  return out
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
  // Objects with no source span (created after parsing) wait here until the next gap, so they
  // can be placed on lines of their own rather than glued to the end of the previous object.
  let pending: string[] = []

  const flush = (gap: string): void => {
    if (pending.length === 0) {
      if (gap !== '') out.push(gap)
      return
    }
    // Split the gap after the line break that ends the previous object: new objects go after
    // it, each preceded by a blank line, and the rest of the gap (blank lines, comments,
    // indentation) stays in front of whatever follows.
    const nl = gap.indexOf('\n')
    const head = nl === -1 ? '' : gap.slice(0, nl + 1)
    const rest = nl === -1 ? gap : gap.slice(nl + 1)
    if (head !== '') out.push(head)
    const atStart = out.length === 0
    const last = out[out.length - 1]
    if (!atStart && last !== undefined && !last.endsWith('\n')) out.push('\n')
    pending.forEach((text, i) => {
      if (!(atStart && i === 0)) out.push('\n')
      out.push(text)
    })
    pending = []
    if (rest !== '') out.push(rest)
  }

  for (const id of doc.order) {
    const obj = doc.objects.get(id)
    if (!obj) continue

    const hasSpan = obj.start !== null && obj.end !== null

    if (!hasSpan) {
      pending.push(renderObject(obj, options, doc.source))
      continue
    }

    // Emit the gap between the previous object and this one, verbatim. An object reordered
    // before the cursor has had its preceding gap consumed already.
    flush(obj.start! > cursor ? gapText(doc, cursor, obj.start!) : '')

    if (obj.dirty) {
      out.push(renderObject(obj, options, doc.source))
    } else {
      out.push(doc.source.slice(obj.start!, obj.end!))
    }

    cursor = Math.max(cursor, obj.end!)
  }

  // Trailing gap: comments or whitespace after the final object.
  flush(cursor < doc.source.length ? gapText(doc, cursor, doc.source.length) : '')

  return out.join('')
}
