/**
 * Ad-hoc corpus survey: counts real class declarations using the parser.
 * A plain grep over-counts, because IDF field *values* are often class-like
 * tokens at line start (`Roof,   !- Surface Type`).
 *
 *   npx tsx scripts/survey-corpus.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIdf } from '../src/parser/index.js'

const dir = join(import.meta.dirname, '..', 'test', 'fixtures', 'testfiles')
const files = readdirSync(dir).filter((f) => f.endsWith('.idf')).sort()

const classFiles = new Map<string, Set<string>>()
const classCount = new Map<string, number>()
let totalObjects = 0
let totalBytes = 0
const t0 = performance.now()

for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  totalBytes += src.length
  const doc = parseIdf(src)
  totalObjects += doc.order.length
  for (const [cls, ids] of doc.byClass) {
    classCount.set(cls, (classCount.get(cls) ?? 0) + ids.length)
    let set = classFiles.get(cls)
    if (!set) { set = new Set(); classFiles.set(cls, set) }
    set.add(f)
  }
}
const ms = performance.now() - t0

console.log(`${files.length} files - ${(totalBytes / 1e6).toFixed(1)} MB - ${totalObjects} objects`)
console.log(`parsed in ${ms.toFixed(0)} ms  (${(totalBytes / 1e6 / (ms / 1000)).toFixed(1)} MB/s)`)
console.log(`${classCount.size} distinct classes\n`)

const TIERS: Array<[string, string[]]> = [
  ['TIER 1  render + edit', [
    'version', 'building', 'globalgeometryrules', 'zone', 'construction',
    'buildingsurface:detailed', 'fenestrationsurface:detailed',
    'shading:site:detailed', 'shading:building:detailed', 'shading:zone:detailed',
  ]],
  ['TIER 2  alternate detailed', ['wall:detailed', 'roofceiling:detailed', 'floor:detailed']],
  ['TIER 3  simple / parametric', [
    'wall:exterior', 'wall:adiabatic', 'wall:underground', 'wall:interzone',
    'roof', 'ceiling:adiabatic', 'ceiling:interzone',
    'floor:groundcontact', 'floor:adiabatic', 'floor:interzone',
    'window', 'door', 'glazeddoor', 'window:interzone', 'door:interzone', 'glazeddoor:interzone',
    'shading:site', 'shading:building', 'shading:overhang', 'shading:overhang:projection',
    'shading:fin', 'shading:fin:projection', 'internalmass',
  ]],
]

for (const [label, list] of TIERS) {
  console.log(`--- ${label} ---`)
  for (const c of list) {
    const n = classCount.get(c) ?? 0
    if (n > 0) {
      console.log(`  ${c.padEnd(32)} ${String(n).padStart(6)} objs  in ${String(classFiles.get(c)!.size).padStart(3)} files`)
    }
  }
  const absent = list.filter((c) => !classCount.has(c))
  if (absent.length > 0) console.log(`  absent: ${absent.join(', ')}`)
  console.log()
}
