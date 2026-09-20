/**
 * Version-resolved access to the IDD field table.
 *
 * IDF is positional: `BuildingSurface:Detailed` field 5 is `Outside Boundary Condition`
 * only because the IDD for *that release* says so. v9.6 inserted `Space Name` at index 4 and
 * shifted everything after it, so a hardcoded index silently reads the space name — usually
 * blank, so surface pairing finds no matches instead of erroring. Every field access in the
 * model layer goes through here, by name.
 *
 * See docs/03-idf-geometry.md §Field orders.
 */
import {
  IDD_TABLE,
  IDD_VERSIONS,
  type IddClass,
  type IddField,
} from '../parser/idd-table.generated.js'

export type { IddField, IddClass }

/** Newest release the table covers. Used when a file declares no version. */
export const LATEST_IDD_VERSION: string = IDD_VERSIONS[IDD_VERSIONS.length - 1]!
/** Oldest release the table covers. */
export const EARLIEST_IDD_VERSION: string = IDD_VERSIONS[0]!

export interface VersionResolution {
  /** The table key to read schemas from. Always a covered release. */
  version: string
  /** What the file declared, normalized to `major.minor`. Absent if it declared nothing usable. */
  declared?: string
  /** True when `declared` is itself a covered release. */
  exact: boolean
}

/** `24.2.0` → `24.2`. Returns undefined for anything not shaped like a version. */
export function normalizeVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const m = /^\s*(\d+)\.(\d+)/.exec(raw)
  return m ? `${m[1]}.${m[2]}` : undefined
}

function compareVersions(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number) as [number, number]
  const [bm, bn] = b.split('.').map(Number) as [number, number]
  return am !== bm ? am - bm : an - bn
}

/**
 * Map a declared version onto a covered release.
 *
 * Field layouts change at a release and then hold until the next change, so the right shape
 * for an uncovered version is the newest covered release at or below it. A file newer than
 * our newest IDD gets the newest we have — which is the common case in practice: the corpus
 * declares 26.2 while the archive stops at 26.1.
 */
export function resolveIddVersion(declaredRaw: string | undefined): VersionResolution {
  const declared = normalizeVersion(declaredRaw)
  if (declared === undefined) return { version: LATEST_IDD_VERSION, exact: false }
  if (IDD_VERSIONS.includes(declared)) return { version: declared, declared, exact: true }

  let best = EARLIEST_IDD_VERSION
  for (const v of IDD_VERSIONS) {
    if (compareVersions(v, declared) <= 0) best = v
  }
  return { version: best, declared, exact: false }
}

/** A single class's field layout at one resolved version, with a name → index map. */
export interface ClassSchema {
  classKey: string
  /** Canonical casing as the IDD spells it. */
  className: string
  /** The covered release this layout came from. */
  version: string
  /**
   * Fixed head plus exactly one extensible group — the table stores no more than that.
   * Use {@link fieldSpecAt} rather than indexing past `fields.length`.
   */
  fields: readonly IddField[]
  extensible?: { stride: number; beginIndex: number }
  minFields?: number
  /** Lowercased field name → index into `fields`. */
  index: ReadonlyMap<string, number>
}

const schemaCache = new Map<string, ClassSchema | null>()

function build(classKey: string, version: string, cls: IddClass): ClassSchema {
  const index = new Map<string, number>()
  cls.fields.forEach((f, i) => {
    const key = f.name.toLowerCase()
    // First wins: duplicate field names exist in a few classes, and the earlier slot is
    // the one a positional reader would reach first.
    if (!index.has(key)) index.set(key, i)
  })
  const schema: ClassSchema = {
    classKey,
    className: cls.name,
    version,
    fields: cls.fields,
    index,
  }
  if (cls.extensible) schema.extensible = cls.extensible
  if (cls.minFields !== undefined) schema.minFields = cls.minFields
  return schema
}

/**
 * Look up a class layout. Returns undefined for classes outside the table — which is most
 * of an IDF file, and is not an error: the Document layer preserves them regardless.
 */
export function getSchema(classKey: string, version: string): ClassSchema | undefined {
  const cacheKey = `${classKey}@${version}`
  const hit = schemaCache.get(cacheKey)
  if (hit !== undefined) return hit ?? undefined

  const entry = IDD_TABLE[classKey]
  const shapeIndex = entry?.byVersion[version]
  const cls = entry && shapeIndex !== undefined ? entry.shapes[shapeIndex] : undefined
  if (!cls) {
    schemaCache.set(cacheKey, null)
    return undefined
  }
  const schema = build(classKey, version, cls)
  schemaCache.set(cacheKey, schema)
  return schema
}

/** Index of a named field, or -1. Case-insensitive. */
export function fieldIndex(schema: ClassSchema, name: string): number {
  return schema.index.get(name.toLowerCase()) ?? -1
}

/**
 * The IDD spec for field `i`, expanding the extensible tail. `undefined` past the end of a
 * non-extensible class.
 */
export function fieldSpecAt(schema: ClassSchema, i: number): IddField | undefined {
  if (i < 0) return undefined
  if (i < schema.fields.length) return schema.fields[i]
  const ext = schema.extensible
  if (!ext) return undefined
  const offset = (i - ext.beginIndex) % ext.stride
  return schema.fields[ext.beginIndex + offset]
}

/**
 * Display name for field `i`, with the extensible group number substituted:
 * `Vertex 1 X-coordinate` at the third group becomes `Vertex 3 X-coordinate`.
 *
 * The substitution is textual because the IDD gives us no structured group number — it
 * spells all 120 vertices out and we keep only the first. It only affects `!-` comments on
 * regenerated objects and inspector labels; nothing parses these back.
 */
export function fieldNameAt(schema: ClassSchema, i: number): string | undefined {
  const spec = fieldSpecAt(schema, i)
  if (!spec) return undefined
  const ext = schema.extensible
  if (!ext || i < schema.fields.length) return spec.name
  const group = Math.floor((i - ext.beginIndex) / ext.stride) + 1
  return spec.name.replace(/\b1\b/, String(group))
}

/**
 * Raw value of a named field: as written and trimmed, `''` when the field is blank, absent
 * from a short object, or unknown to this class.
 *
 * Blank and absent are deliberately not distinguished — IDF treats both as "use the default".
 */
export function readField(
  obj: { fields: ReadonlyArray<{ value: string }> },
  schema: ClassSchema,
  name: string,
): string {
  const i = fieldIndex(schema, name)
  if (i === -1) return ''
  return obj.fields[i]?.value ?? ''
}

/** {@link readField}, falling back to the IDD default. `''` when there is no default. */
export function readFieldOrDefault(
  obj: { fields: ReadonlyArray<{ value: string }> },
  schema: ClassSchema,
  name: string,
): string {
  const raw = readField(obj, schema, name)
  if (raw !== '') return raw
  const i = fieldIndex(schema, name)
  if (i === -1) return ''
  return schema.fields[i]?.default ?? ''
}

/**
 * Numeric value of a named field, after defaulting. `undefined` when the result is not a
 * finite number — which covers `autocalculate`, `autosize`, and parametric-preprocessor
 * placeholders like `=$appGAngle` (real: `LBuildingAppGRotPar.idf` writes exactly that into
 * `Compliance:Building`). Callers decide whether that is benign or worth reporting.
 */
export function readNumber(
  obj: { fields: ReadonlyArray<{ value: string }> },
  schema: ClassSchema,
  name: string,
): number | undefined {
  const raw = readFieldOrDefault(obj, schema, name)
  if (raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** Where a class keeps its vertex triples, derived from the table rather than hardcoded. */
export interface VertexLayout {
  /** Index of `Vertex 1 X-coordinate`. */
  beginIndex: number
  /** Always 3 in practice; read from the extensible marker where there is one. */
  stride: number
  /**
   * Hard cap on vertex count. `Infinity` for extensible classes; 4 for
   * `FenestrationSurface:Detailed`, which has no `\extensible` marker and whose last IDD
   * slot is literally `N15; Vertex 4 Z-coordinate`. The editor must refuse a 5th vertex on
   * a sub-surface rather than emit an object EnergyPlus will reject.
   */
  max: number
}

const VERTEX_1_X = 'vertex 1 x-coordinate'

/** `undefined` for classes that carry no explicit vertices (every Tier 3 class, and `Zone`). */
export function vertexLayout(schema: ClassSchema): VertexLayout | undefined {
  const begin = schema.index.get(VERTEX_1_X)
  if (begin === undefined) return undefined

  const ext = schema.extensible
  if (ext && ext.beginIndex === begin) {
    return { beginIndex: begin, stride: ext.stride, max: Infinity }
  }
  // Non-extensible: the vertices are spelled out, so count them.
  let n = 0
  while (schema.index.has(`vertex ${n + 1} x-coordinate`)) n++
  return { beginIndex: begin, stride: 3, max: n }
}
