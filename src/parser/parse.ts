import type { IdfDiagnostic, IdfDocument, IdfField, IdfObject } from './types.js'

const CH_COMMENT = 0x21 /* ! */
const CH_COMMA = 0x2c /* , */
const CH_SEMI = 0x3b /* ; */
const CH_HASH = 0x23 /* # */
const CH_LF = 0x0a
const CH_CR = 0x0d
const CH_TAB = 0x09
const CH_SPACE = 0x20
const CH_VTAB = 0x0b
const CH_FF = 0x0c
const CH_BOM = 0xfeff

function isSpace(c: number): boolean {
  return (
    c === CH_SPACE ||
    c === CH_TAB ||
    c === CH_LF ||
    c === CH_CR ||
    c === CH_VTAB ||
    c === CH_FF ||
    c === CH_BOM
  )
}

/** True when `i` is the first non-blank character of its line. */
function atLineStart(text: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = text.charCodeAt(j)
    if (c === CH_LF || c === CH_CR) return true
    if (c !== CH_SPACE && c !== CH_TAB && c !== CH_BOM) return false
  }
  return true
}

/**
 * Advance past whitespace, standalone comments and EPMacro directives to the start of the
 * next object.
 *
 * EPMacro (`.imf`) directives — `##include`, `##ifdef`, `##set1` and friends — are not IDF
 * syntax. Without this, a directive sitting between two objects becomes the leading text of
 * the next object's class name, yielding entries like `"##elseif ...\n\n SizingPeriod:DesignDay"`.
 * Round-tripping still succeeds (gaps are emitted verbatim), but the object model is junk.
 * We cannot *expand* macros — that is EPMacro's job — so we skip them and let the caller
 * warn that the file needs preprocessing.
 */
function skipGap(text: string, from: number): { index: number; macros: number } {
  let i = from
  let macros = 0
  const n = text.length
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === CH_COMMENT) {
      while (i < n && text.charCodeAt(i) !== CH_LF) i++
    } else if (c === CH_HASH && atLineStart(text, i)) {
      macros++
      while (i < n && text.charCodeAt(i) !== CH_LF) i++
    } else if (isSpace(c)) {
      i++
    } else {
      break
    }
  }
  return { index: i, macros }
}

/** Strip the comment marker and one leading `-` plus surrounding whitespace. */
function normalizeComment(raw: string): string {
  return raw.replace(/^[ \t]*/, '').replace(/[ \t\r]*$/, '')
}

interface ParsedObject {
  className: string
  fields: IdfField[]
  end: number
  unterminated: boolean
}

/**
 * Parse a single object starting at `start` (which must be the first character of the
 * class name). Comment spans are excluded from field values but their text is captured
 * as the trailing comment of the field whose delimiter they follow on the same line.
 */
function parseObject(text: string, start: number): ParsedObject {
  const n = text.length
  const fields: IdfField[] = []
  let parts: string[] = []
  let segStart = start
  let i = start
  // Offset of the delimiter that closed the most recent field, and whether a newline
  // has been seen since — together these decide comment ownership.
  let sawNewlineSinceDelim = false

  const closeField = (): void => {
    parts.push(text.slice(segStart, i))
    const rawVal = parts.join('')
    const trimmed = rawVal.trim()
    let valueStart: number | undefined
    let valueEnd: number | undefined
    if (trimmed.length > 0) {
      const segText = text.slice(segStart, i)
      const lead = segText.indexOf(trimmed)
      if (lead !== -1) {
        valueStart = segStart + lead
        valueEnd = valueStart + trimmed.length
      }
    } else {
      valueStart = segStart
      valueEnd = segStart
    }
    fields.push({ value: trimmed, valueStart, valueEnd })
    parts = []
  }

  while (i < n) {
    const c = text.charCodeAt(i)

    if (c === CH_COMMENT) {
      let e = i + 1
      while (e < n && text.charCodeAt(e) !== CH_LF) e++
      const commentText = normalizeComment(text.slice(i + 1, e))
      const owner = fields[fields.length - 1]
      if (owner && !sawNewlineSinceDelim && commentText !== '') {
        owner.comment = commentText
      } else {
        parts.push(text.slice(segStart, i))
      }
      i = e
      segStart = i
      continue
    }

    if (c === CH_COMMA || c === CH_SEMI) {
      closeField()
      i++
      if (c === CH_SEMI) {
        // The final field's comment sits after the terminator: `0.0;  !- North Axis`.
        // Absorb it into the object so that regenerating a dirty object cannot duplicate
        // or orphan it. Only when the rest of the line holds nothing but that comment —
        // `Zone,A;Zone,B;` must not swallow the second object.
        let j = i
        while (j < n && (text.charCodeAt(j) === CH_SPACE || text.charCodeAt(j) === CH_TAB)) j++
        if (j < n && text.charCodeAt(j) === CH_COMMENT) {
          let e = j + 1
          while (e < n && text.charCodeAt(e) !== CH_LF) e++
          const commentText = normalizeComment(text.slice(j + 1, e))
          const owner = fields[fields.length - 1]
          if (owner && fields.length > 1 && commentText !== '') owner.comment = commentText
          i = e
        }
        return { className: fields[0]?.value ?? '', fields: fields.slice(1), end: i, unterminated: false }
      }
      segStart = i
      sawNewlineSinceDelim = false
      continue
    }

    if (c === CH_LF) sawNewlineSinceDelim = true
    i++
  }

  // Ran to EOF without a terminating `;`.
  closeField()
  return { className: fields[0]?.value ?? '', fields: fields.slice(1), end: i, unterminated: true }
}

/**
 * Parse IDF text into a document. Never throws on malformed input — problems are recorded
 * as diagnostics and the offending text is still preserved for round-tripping.
 */
export function parseIdf(source: string): IdfDocument {
  const objects = new Map<string, IdfObject>()
  const order: string[] = []
  const byClass = new Map<string, string[]>()
  const diagnostics: IdfDiagnostic[] = []

  let i = 0
  let counter = 0
  let macroDirectives = 0
  let firstMacroOffset = -1

  while (true) {
    const gap = skipGap(source, i)
    if (gap.macros > 0) {
      macroDirectives += gap.macros
      if (firstMacroOffset === -1) firstMacroOffset = i
    }
    i = gap.index
    if (i >= source.length) break

    const start = i
    const parsed = parseObject(source, start)
    const id = `o${counter++}`
    const classKey = parsed.className.toLowerCase()

    const obj: IdfObject = {
      id,
      className: parsed.className,
      classKey,
      fields: parsed.fields,
      start,
      end: parsed.end,
      dirty: false,
    }
    if (parsed.unterminated) {
      obj.unterminated = true
      diagnostics.push({
        severity: 'error',
        message: `Object '${parsed.className}' is not terminated with ';'`,
        offset: start,
        objectId: id,
      })
    }
    if (parsed.className === '') {
      diagnostics.push({
        severity: 'error',
        message: 'Object has an empty class name',
        offset: start,
        objectId: id,
      })
    }

    objects.set(id, obj)
    order.push(id)
    const list = byClass.get(classKey)
    if (list) list.push(id)
    else byClass.set(classKey, [id])

    i = parsed.end
  }

  const doc: IdfDocument = { source, objects, order, byClass, diagnostics }

  if (macroDirectives > 0) {
    // The objects we did parse are sound, but any object guarded by a conditional is
    // present unconditionally and `##include` bodies are missing entirely — so the model
    // is not a faithful picture of what EnergyPlus would simulate.
    diagnostics.push({
      severity: 'warning',
      message:
        `File contains ${macroDirectives} EPMacro directive(s). Macros are preserved but not ` +
        `expanded; run EPMacro first for a complete model.`,
      offset: firstMacroOffset,
    })
  }

  const versionIds = byClass.get('version')
  const versionObj = versionIds && versionIds.length > 0 ? objects.get(versionIds[0]!) : undefined
  const versionField = versionObj?.fields[0]?.value
  if (versionField !== undefined && versionField !== '') doc.version = versionField

  return doc
}
