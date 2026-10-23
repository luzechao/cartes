/**
 * The full EnergyPlus schema — every class, not just the geometry subset the model layer's own
 * IDD table carries — from `@idfkit/schemas`, with validation and descriptions from
 * `@idfkit/core`.
 *
 * Loaded on demand and shared: the bundle holds every release from 8.9 to 26.2 in ~1 MB
 * gzipped, and a release costs only its small manifest once the shared type store is in. In the
 * browser it is fetched from `public/schemas/` (copied there by `scripts/copy-schemas.mjs`);
 * Node callers install the package's own copy with `setSchemaBundle(localBundle())`.
 *
 * cartes still owns the document and every write: idfkit only reads. Field positions line up
 * because both read the same IDD order — `f` is the fixed fields in IDF order (the name first,
 * when the class has one) and `x` the repeating group after them.
 */
import { SchemaBundle, httpSource, type ProsePool, type Schema, type SlimField, type SlimType } from '@idfkit/schemas'
import { docsUrlForObject, parseIdf, validateDocument } from '@idfkit/core'

export type { Schema, SlimField, SlimType, ProsePool }

let bundle: SchemaBundle | undefined

/** Use this bundle from now on — in Node, `localBundle()` from `@idfkit/schemas/node`. */
export function setSchemaBundle(next: SchemaBundle): void {
  bundle = next
}

function getBundle(): SchemaBundle {
  bundle ??= new SchemaBundle(httpSource(`${import.meta.env?.BASE_URL ?? '/'}schemas/`))
  return bundle
}

function parseVersion(v: string): [number, number] | undefined {
  const m = /^(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2])] : undefined
}

/**
 * The bundled release to read a model of `modelVersion` (`major.minor`) with: the same release,
 * else the newest older one. Undefined for files older than 8.9, which the bundle does not cover.
 */
export function pickSchemaVersion(modelVersion: string, available: readonly string[]): string | undefined {
  const want = parseVersion(modelVersion)
  if (!want) return available[available.length - 1]
  const cmp = (v: string): number => {
    const [a, b] = parseVersion(v)!
    return a !== want[0] ? a - want[0] : b - want[1]
  }
  const exact = available.find((v) => cmp(v) === 0)
  if (exact) return exact
  const older = available.filter((v) => cmp(v) < 0)
  return older[older.length - 1]
}

export async function loadSchema(modelVersion: string): Promise<Schema | undefined> {
  const b = getBundle()
  const version = pickSchemaVersion(modelVersion, await b.versions())
  return version ? b.load(version) : undefined
}

/** Field notes and class memos, ~180 KB; only descriptions need them. */
export function loadProse(): Promise<ProsePool> {
  return getBundle().loadProse()
}

// --- field layout ------------------------------------------------------------

export interface FieldSlot {
  /** epJSON field name, e.g. `outside_boundary_condition`, `vertex_x_coordinate`. */
  key: string
  def: SlimField | undefined
  /** 1-based repeat number, for a field in the extensible group. */
  group?: number
}

/** The schema's description of IDF field `i` (0 = the first field after the class name). */
export function slotAt(type: SlimType, i: number): FieldSlot | undefined {
  if (i < 0) return undefined
  if (i < type.f.length) return { key: type.f[i]!, def: type.p[type.f[i]!] }
  const x = type.x
  if (!x || x.fields.length === 0) return undefined
  const j = i - type.f.length
  const key = x.fields[j % x.fields.length]!
  return { key, def: x.p[key], group: Math.floor(j / x.fields.length) + 1 }
}

/** `Outside Boundary Condition Object` and `outside_boundary_condition_object` alike → the latter. */
export function normalizeFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * The index of a field named in either spelling. Repeating fields take their repeat number:
 * `Vertex 3 X-coordinate` or `vertex_3_x_coordinate`, `Field 5` for `Schedule:Compact`.
 */
export function slotIndex(type: SlimType, name: string): number | undefined {
  const n = normalizeFieldName(name)
  const fixed = type.f.indexOf(n)
  if (fixed >= 0) return fixed
  const x = type.x
  if (!x) return undefined
  const plain = x.fields.indexOf(n)
  if (plain >= 0) return type.f.length + plain
  for (const m of n.matchAll(/(^|_)(\d+)(?=_|$)/g)) {
    const without = (n.slice(0, m.index) + n.slice(m.index + m[0].length)).replace(/^_+/, '')
    const pos = x.fields.indexOf(without)
    const group = Number(m[2])
    if (pos >= 0 && group >= 1) return type.f.length + (group - 1) * x.fields.length + pos
  }
  return undefined
}

// Kept lowercase inside a name, as the IDD writes them: `Flow Rate per Floor Area`.
const MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'per', 'the', 'to', 'with'])

/** `outside_boundary_condition` → `Outside Boundary Condition`, with the repeat number for a group. */
export function displayName(slot: FieldSlot): string {
  const words = slot.key
    .split('_')
    .map((w, i) => (!w || (i > 0 && MINOR_WORDS.has(w)) ? w : w[0]!.toUpperCase() + w.slice(1)))
  if (slot.group !== undefined) words.splice(1, 0, String(slot.group))
  return words.join(' ')
}

const AUTO = /^(autosize|autocalculate)$/i

/** Why `raw` is not a legal value for a field, or undefined if it is. Blank is always legal here. */
export function valueProblem(def: SlimField | undefined, raw: string | number): string | undefined {
  const value = String(raw).trim()
  if (!def || value === '' || def.t === 'arr') return undefined
  const choices = def.e?.filter((c) => c !== '')
  if (def.t === 'a') {
    if (choices?.length && !choices.some((c) => String(c).toLowerCase() === value.toLowerCase())) {
      return `must be one of ${choices.map(String).join(', ')}`
    }
    return undefined
  }
  if (def.auto) {
    // No string list means any string is legal there (Schedule:Compact's `field`).
    if (!def.se) return undefined
    if (def.se.some((s) => s.toLowerCase() === value.toLowerCase())) return undefined
    // EnergyPlus takes Autosize and Autocalculate for each other; see `schemaIssues`.
    if (AUTO.test(value) && def.se.some((s) => AUTO.test(s))) return undefined
  }
  const n = Number(value)
  if (!Number.isFinite(n)) {
    const words = def.se?.filter((s) => s !== '') ?? []
    return words.length ? `must be a number or ${words.join(' or ')}` : 'must be a number'
  }
  if (choices?.length && !choices.some((c) => Number(c) === n)) return `must be one of ${choices.join(', ')}`
  if (def.t === 'i' && !Number.isInteger(n)) return 'must be a whole number'
  if (def.min !== undefined && (def.xmin === true ? n <= def.min : n < def.min)) {
    return def.xmin === true ? `must be greater than ${def.min}` : `must be at least ${def.min}`
  }
  if (typeof def.xmin === 'number' && n <= def.xmin) return `must be greater than ${def.xmin}`
  if (def.max !== undefined && (def.xmax === true ? n >= def.max : n > def.max)) {
    return def.xmax === true ? `must be less than ${def.max}` : `must be at most ${def.max}`
  }
  if (typeof def.xmax === 'number' && n >= def.xmax) return `must be less than ${def.xmax}`
  return undefined
}

// --- validation ----------------------------------------------------------------

export interface SchemaIssue {
  severity: 'error' | 'warning' | 'info'
  /** idfkit's code, e.g. E002 wrong type, E003/E004 bad value, E005–E008 out of range, E009 dangling reference. */
  code: string
  className: string
  /** Empty for unnamed objects. */
  objectName: string
  /** epJSON field name, when the issue concerns one field. */
  field?: string
  message: string
}

/**
 * Field-level checks over every object in an IDF text — choices, numbers, bounds, required
 * fields, references and singletons — as idfkit (and idfkit-mcp) run them.
 *
 * One difference, measured: idfkit reports `AUTOCALCULATE` in a field whose schema lists only
 * `Autosize` (and the reverse). EnergyPlus accepts either — 836 such values across 164 of its own
 * example files, which run, `5ZoneAirCooled` among them in this app's engine — so those are not
 * reported.
 */
export function schemaIssues(text: string, schema: Schema): SchemaIssue[] {
  const { document } = parseIdf(text, schema, { strict: false })
  const result = validateDocument(document)
  const out: SchemaIssue[] = []
  for (const e of [...result.errors, ...result.warnings, ...result.info]) {
    if (e.code === 'E004' && /^Value '(autosize|autocalculate)'/i.test(e.message) && /'(Autosize|Autocalculate)'\]/.test(e.message)) {
      continue
    }
    out.push({
      severity: e.severity,
      code: e.code,
      className: e.objType,
      objectName: e.objName,
      ...(e.field !== undefined ? { field: e.field } : {}),
      message: e.message,
    })
  }
  return out
}

// --- descriptions -------------------------------------------------------------------

export interface FieldDescription {
  index: number
  name: string
  type: 'text' | 'number' | 'integer'
  required?: true
  units?: string
  default?: string | number
  choices?: Array<string | number>
  /** Also accepted in a numeric field, e.g. `Autosize`. */
  alsoAccepts?: string[]
  min?: number
  max?: number
  exclusiveMin?: number
  exclusiveMax?: number
  /** Reference lists the value must name an object from. */
  references?: string[]
  note?: string
}

export interface ClassDescription {
  class: string
  group?: string
  memo?: string
  docs?: string
  /** Whether objects carry a name, and whether it must be given. */
  name: 'required' | 'optional' | 'none'
  singleton?: true
  /** Reference lists an object's name joins — what other objects' fields can point at it through. */
  nameReferencedAs?: string[]
  fields: FieldDescription[]
  /** The repeating tail: `fields` repeat from `startsAt`, one group after another. */
  extensible?: { startsAt: number; fields: FieldDescription[] }
}

const NOTE_LIMIT = 280

function describeField(index: number, name: string, def: SlimField | undefined, required: boolean, prose?: ProsePool): FieldDescription {
  const d: FieldDescription = { index, name, type: def?.t === 'n' ? 'number' : def?.t === 'i' ? 'integer' : 'text' }
  if (!def) return d
  if (required) d.required = true
  if (def.u) d.units = def.u
  if (def.d !== undefined) d.default = def.d
  const choices = def.e?.filter((c) => c !== '')
  if (choices?.length) d.choices = choices
  const also = def.se?.filter((s) => s !== '')
  if (def.auto && also?.length) d.alsoAccepts = also
  if (def.min !== undefined) {
    if (def.xmin === true) d.exclusiveMin = def.min
    else d.min = def.min
  }
  if (typeof def.xmin === 'number') d.exclusiveMin = def.xmin
  if (def.max !== undefined) {
    if (def.xmax === true) d.exclusiveMax = def.max
    else d.max = def.max
  }
  if (typeof def.xmax === 'number') d.exclusiveMax = def.xmax
  if (def.ol?.length) d.references = def.ol
  const note = def.n !== undefined ? prose?.[def.n] : undefined
  if (note) d.note = note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT)}…` : note
  return d
}

/** A class's fields — positions, types, units, choices, bounds, references and notes. */
export function describeClass(schema: Schema, className: string, prose?: ProsePool): ClassDescription | undefined {
  const canonical = schema.resolve(className)
  const type = canonical ? schema.get(canonical) : undefined
  if (!canonical || !type) return undefined
  const required = new Set(type.r ?? [])
  const d: ClassDescription = {
    class: canonical,
    name: type.anon ? 'none' : type.nreq ? 'required' : 'optional',
    fields: type.f.flatMap((key, i) =>
      !type.anon && i === 0 && key === 'name' ? [] : [describeField(i, key, type.p[key], required.has(key), prose)],
    ),
  }
  if (type.g) d.group = type.g
  const memo = type.m !== undefined ? prose?.[type.m] : undefined
  if (memo) d.memo = memo
  const docs = docsUrlForObject(canonical, schema.version, schema)
  if (docs) d.docs = docs.url
  if (type.s) d.singleton = true
  if (type.nref?.length) d.nameReferencedAs = type.nref
  if (type.x) {
    const x = type.x
    d.extensible = {
      startsAt: type.f.length,
      fields: x.fields.map((key, j) => describeField(type.f.length + j, key, x.p[key], false, prose)),
    }
  }
  return d
}

export interface ClassMatch {
  class: string
  group?: string
  summary?: string
}

/** Classes whose name or group contains every word of `query`. */
export function findClasses(schema: Schema, query: string, prose?: ProsePool, limit = 30): { matches: ClassMatch[]; total: number } {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const hits = schema.typeNames.filter((name) => {
    const hay = `${name} ${schema.get(name)?.g ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  // Shorter names first: `Material` before `Material:AirGap` before `MaterialProperty:…`.
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return {
    total: hits.length,
    matches: hits.slice(0, limit).map((name) => {
      const type = schema.get(name)!
      const m: ClassMatch = { class: name }
      if (type.g) m.group = type.g
      const memo = type.m !== undefined ? prose?.[type.m] : undefined
      if (memo) {
        const first = /^.*?[.!?](\s|$)/.exec(memo)?.[0]?.trim() ?? memo
        m.summary = first.length > 160 ? `${first.slice(0, 160)}…` : first
      }
      return m
    }),
  }
}
