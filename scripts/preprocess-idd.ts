/**
 * Compile the EnergyPlus IDD archive into a compact, version-keyed field table.
 *
 *   ./scripts/fetch-idd.sh          # populate idd-cache/ (~120 MB, gitignored)
 *   npm run preprocess-idd          # -> src/parser/idd-table.generated.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * IDF is a positional format: `BuildingSurface:Detailed` field 5 means "Outside Boundary
 * Condition" only because the IDD says so, and *which* index that is has changed across
 * releases (v9.6 inserted `Space Name` at index 4, shifting everything after it). Parsing
 * by field name is impossible without this table; parsing by hardcoded index is a
 * correctness bug waiting for the next release. EPShape takes this approach but covers
 * only five classes and omits GlobalGeometryRules, which is why it cannot honour relative
 * coordinates.
 *
 * TWO COMPRESSIONS MAKE THE OUTPUT SMALL
 * --------------------------------------
 * 1. Extensible truncation. The IDD spells out all 120 vertices of
 *    BuildingSurface:Detailed -- 368 fields. We keep the fixed head plus one extensible
 *    group and record the stride, collapsing 368 -> 13.
 * 2. Shape dedup. A class's field list is usually identical across many releases. We store
 *    each distinct shape once and map versions onto it.
 *
 * Raw IDDs are ~4.5 MB x 27 releases; the emitted table is a few tens of KB.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CACHE = join(ROOT, 'idd-cache')
const OUT = join(ROOT, 'src', 'parser', 'idd-table.generated.ts')

/** The IDD group that holds every geometry class, per `\group` markers in the IDD itself. */
const GEOMETRY_GROUP = 'Thermal Zones and Surfaces'

/**
 * Classes the editor needs that live outside the geometry group. Kept deliberately short:
 * everything else is discovered from the IDD rather than hardcoded here.
 *
 * `Compliance:Building` lives in "Simulation Parameters" but carries `Building Rotation for
 * Appendix G`, which EnergyPlus applies to every vertex *even in World coordinates*
 * (`SurfaceGeometry.cc`, the `CosBldgRotAppGonly` branch). Without it the geometry layer
 * silently disagrees with EnergyPlus on every Appendix G baseline model.
 *
 * `Daylighting:ReferencePoint` and `Output:IlluminanceMap` live in "Daylighting" but are
 * positioned in a zone's coordinate frame (per `GlobalGeometryRules` field 4), so a whole-zone
 * translate must carry them with it or leave the sensors outside the room they measure.
 */
const EXTRA_CLASSES = new Set(
  [
    'Version',
    'Building',
    'Compliance:Building',
    'Construction',
    'Daylighting:ReferencePoint',
    'Output:IlluminanceMap',
  ].map((c) => c.toLowerCase()),
)

// ---------------------------------------------------------------------------
// Types (mirrored into the generated file)
// ---------------------------------------------------------------------------

interface IddField {
  name: string
  /** `A` = alphanumeric slot, `N` = numeric slot. */
  type: 'A' | 'N'
  required?: boolean
  default?: string
  units?: string
  /** `\key` values for `\type choice` fields. */
  choices?: string[]
  /** `\object-list` targets — the field holds the name of another object. */
  objectList?: string[]
}

interface IddClass {
  /** Canonical casing as the IDD spells it. */
  name: string
  group: string
  minFields?: number
  /**
   * Present when the class has a repeating tail. `fields` is truncated to
   * `beginIndex + stride`; index `beginIndex + k*stride + j` reuses `fields[beginIndex + j]`.
   */
  extensible?: { stride: number; beginIndex: number }
  fields: IddField[]
}

// ---------------------------------------------------------------------------
// IDD parsing
// ---------------------------------------------------------------------------

/** `  A1 , \field Name` / `  N362; \field Vertex 120 Z-coordinate` */
const SLOT_RE = /^\s*([AN])(\d+)\s*[,;]\s*(?:\\field\s*(.*))?$/
/** A class declaration sits at column 0 and is just `Name,`. */
const CLASS_RE = /^([A-Za-z][A-Za-z0-9:_.\-]*)\s*,\s*$/
const GROUP_RE = /^\\group\s+(.*?)\s*$/

function stripInline(s: string): string {
  return s.trim()
}

/**
 * Parse one IDD file into classes, keeping only those we care about.
 *
 * The IDD is line-oriented: a class header at column 0, then indented field slots, each
 * optionally followed by `\`-prefixed metadata lines that apply to the most recent slot
 * (or to the class itself, when they precede the first slot).
 */
function parseIdd(text: string, wanted: (classKey: string, group: string) => boolean): Map<string, IddClass> {
  const out = new Map<string, IddClass>()
  const lines = text.split('\n')

  let group = ''
  let cls: IddClass | null = null
  let keep = false
  /** Index of the field the current metadata lines attach to; -1 = class-level. */
  let cur = -1
  /** Set by `\extensible:N` on the class, resolved against `\begin-extensible` later. */
  let stride = 0
  let beginIndex = -1

  const flush = (): void => {
    if (cls && keep) {
      if (stride > 0 && beginIndex >= 0) {
        cls.extensible = { stride, beginIndex }
        // Keep the fixed head plus exactly one extensible group.
        cls.fields = cls.fields.slice(0, beginIndex + stride)
      }
      out.set(cls.name.toLowerCase(), cls)
    }
    cls = null
    keep = false
    cur = -1
    stride = 0
    beginIndex = -1
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')

    // Comment lines are `!`-prefixed; blank lines carry no meaning.
    const t = line.trimStart()
    if (t === '' || t.startsWith('!')) continue

    const g = GROUP_RE.exec(t)
    if (g) {
      flush()
      group = g[1]!
      continue
    }

    // A class header is unindented. Indented lines belong to the current class.
    if (!/^\s/.test(line)) {
      const c = CLASS_RE.exec(line)
      if (c) {
        flush()
        const name = c[1]!
        keep = wanted(name.toLowerCase(), group)
        cls = { name, group, fields: [] }
        continue
      }
      // Unindented and not a class header: some IDDs put `\`-metadata at column 0.
      if (!t.startsWith('\\')) {
        flush()
        continue
      }
    }

    const slot = SLOT_RE.exec(line)
    if (slot) {
      if (!cls) continue
      cur = cls.fields.length
      cls.fields.push({ name: stripInline(slot[3] ?? ''), type: slot[1] as 'A' | 'N' })
      continue
    }

    if (!t.startsWith('\\') || !cls) continue

    // Metadata. Applies to the last slot, or to the class when no slot has been seen.
    const sp = t.indexOf(' ')
    const key = (sp === -1 ? t : t.slice(0, sp)).slice(1).toLowerCase()
    const val = sp === -1 ? '' : stripInline(t.slice(sp + 1))
    const field = cur >= 0 ? cls.fields[cur] : undefined

    switch (key) {
      case 'field':
        // `\field` on its own line (some IDDs wrap it) — retitle the current slot.
        if (field && field.name === '') field.name = val
        break
      case 'extensible': {
        // `\extensible:3 -- duplicate last set of ...`
        const m = /^:?(\d+)/.exec(val) ?? /^:?(\d+)/.exec(t.slice(key.length + 1))
        if (m) stride = Number(m[1])
        break
      }
      case 'begin-extensible':
        if (cur >= 0) beginIndex = cur
        break
      case 'min-fields':
        cls.minFields = Number(val)
        break
      case 'required-field':
        if (field) field.required = true
        break
      case 'default':
        if (field) field.default = val
        break
      case 'units':
        if (field) field.units = val
        break
      case 'key':
        if (field) (field.choices ??= []).push(val)
        break
      case 'object-list':
        if (field) (field.objectList ??= []).push(val)
        break
      default:
        break
    }
  }
  flush()
  return out
}

/** `\extensible:3` has no space, so the switch above needs the colon form handled too. */
function fixExtensibleKey(text: string): string {
  return text.replace(/\\extensible:(\d+)/g, '\\extensible :$1')
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** `V9-6-0.idd` -> `9.6` */
function versionOf(filename: string): string {
  const m = /^V(\d+)-(\d+)-\d+\.idd$/.exec(filename)
  if (!m) throw new Error(`unexpected IDD filename: ${filename}`)
  return `${m[1]}.${m[2]}`
}

function compareVersions(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number) as [number, number]
  const [bm, bn] = b.split('.').map(Number) as [number, number]
  return am !== bm ? am - bm : an - bn
}

function main(): void {
  const files = readdirSync(CACHE)
    .filter((f) => /^V\d+-\d+-\d+\.idd$/.test(f))
    .sort((a, b) => compareVersions(versionOf(a), versionOf(b)))

  if (files.length === 0) {
    console.error('idd-cache/ is empty — run ./scripts/fetch-idd.sh first')
    process.exit(1)
  }

  const wanted = (classKey: string, group: string): boolean =>
    group === GEOMETRY_GROUP || EXTRA_CLASSES.has(classKey)

  const versions: string[] = []
  /** classKey -> distinct shapes, and version -> index into that array. */
  const shapes = new Map<string, { list: IddClass[]; sigs: string[]; byVersion: Record<string, number> }>()

  for (const f of files) {
    const version = versionOf(f)
    versions.push(version)
    const text = fixExtensibleKey(readFileSync(join(CACHE, f), 'utf8'))
    const classes = parseIdd(text, wanted)

    for (const [key, cls] of classes) {
      let entry = shapes.get(key)
      if (!entry) {
        entry = { list: [], sigs: [], byVersion: {} }
        shapes.set(key, entry)
      }
      const sig = JSON.stringify(cls)
      let idx = entry.sigs.indexOf(sig)
      if (idx === -1) {
        idx = entry.list.length
        entry.list.push(cls)
        entry.sigs.push(sig)
      }
      entry.byVersion[version] = idx
    }
    console.log(`  ${version.padEnd(6)} ${String(classes.size).padStart(3)} classes`)
  }

  // ---- emit -------------------------------------------------------------
  const keys = [...shapes.keys()].sort()
  const totalShapes = keys.reduce((n, k) => n + shapes.get(k)!.list.length, 0)

  const geometryClasses = keys.filter((k) => {
    const e = shapes.get(k)!
    return e.list.some((c) => c.group === GEOMETRY_GROUP)
  })

  const body: string[] = []
  body.push(`/* eslint-disable */`)
  body.push(`// GENERATED by scripts/preprocess-idd.ts — do not edit.`)
  body.push(`// Source: NREL/EnergyPlus idd/versions, ${files.length} releases (${versions[0]} … ${versions[versions.length - 1]}).`)
  body.push(``)
  body.push(`export interface IddField {`)
  body.push(`  name: string`)
  body.push(`  /** \`A\` = alphanumeric slot, \`N\` = numeric slot. */`)
  body.push(`  type: 'A' | 'N'`)
  body.push(`  required?: boolean`)
  body.push(`  default?: string`)
  body.push(`  units?: string`)
  body.push(`  choices?: string[]`)
  body.push(`  objectList?: string[]`)
  body.push(`}`)
  body.push(``)
  body.push(`export interface IddClass {`)
  body.push(`  name: string`)
  body.push(`  group: string`)
  body.push(`  minFields?: number`)
  body.push(`  /**`)
  body.push(`   * Repeating tail. \`fields\` is truncated to \`beginIndex + stride\`; field index`)
  body.push(`   * \`beginIndex + k * stride + j\` reuses \`fields[beginIndex + j]\`.`)
  body.push(`   */`)
  body.push(`  extensible?: { stride: number; beginIndex: number }`)
  body.push(`  fields: IddField[]`)
  body.push(`}`)
  body.push(``)
  body.push(`export interface IddClassEntry {`)
  body.push(`  /** Distinct field layouts this class has had. */`)
  body.push(`  shapes: IddClass[]`)
  body.push(`  /** EnergyPlus version -> index into \`shapes\`. */`)
  body.push(`  byVersion: Record<string, number>`)
  body.push(`}`)
  body.push(``)
  body.push(`/** Every release covered, ascending. */`)
  body.push(`export const IDD_VERSIONS: readonly string[] = ${JSON.stringify(versions)}`)
  body.push(``)
  body.push(`/** Class keys in IDD group ${JSON.stringify(GEOMETRY_GROUP)} — the authoritative geometry set. */`)
  body.push(`export const GEOMETRY_CLASSES: readonly string[] = ${JSON.stringify(geometryClasses, null, 2)}`)
  body.push(``)
  body.push(`/** Lowercased class name -> versioned field layouts. */`)
  body.push(`export const IDD_TABLE: Record<string, IddClassEntry> = {`)
  for (const k of keys) {
    const e = shapes.get(k)!
    body.push(`  ${JSON.stringify(k)}: {`)
    body.push(`    shapes: ${JSON.stringify(e.list)},`)
    body.push(`    byVersion: ${JSON.stringify(e.byVersion)},`)
    body.push(`  },`)
  }
  body.push(`}`)
  body.push(``)

  writeFileSync(OUT, body.join('\n'), 'utf8')

  const bytes = readFileSync(OUT).length
  console.log(``)
  console.log(`${keys.length} classes (${geometryClasses.length} in "${GEOMETRY_GROUP}")`)
  console.log(`${totalShapes} distinct shapes across ${files.length} releases`)
  console.log(`wrote ${OUT.replace(ROOT + '/', '')} — ${(bytes / 1024).toFixed(0)} KB`)
}

main()
