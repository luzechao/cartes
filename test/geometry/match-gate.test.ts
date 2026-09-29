import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, getSchema, setFieldValue, type Model } from '../../src/model/index.js'
import { applyMatchProposals, proposeMatches } from '../../src/geometry/index.js'

/**
 * PHASE 7 GATE (docs/05-implementation-plan.md), corpus half:
 *
 *   On a fixture with known-correct pairing, we reproduce it exactly. On a fixture with
 *   deliberately broken pairing, we propose the correct fix and propose nothing else.
 *
 * Run over every file in the corpus rather than a chosen few. The EnergyPlus half is in
 * `eplus-match.test.ts`.
 */

const BULK_DIR = join(import.meta.dirname, '../fixtures/testfiles')
const VERSIONS_DIR = join(import.meta.dirname, '../fixtures/versions')

function listCorpus(): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = []
  if (existsSync(BULK_DIR)) {
    for (const f of readdirSync(BULK_DIR).filter((x) => x.endsWith('.idf')).sort()) {
      out.push({ label: f, path: join(BULK_DIR, f) })
    }
  }
  if (existsSync(VERSIONS_DIR)) {
    for (const dir of readdirSync(VERSIONS_DIR).sort()) {
      for (const f of readdirSync(join(VERSIONS_DIR, dir)).filter((x) => x.endsWith('.idf')).sort()) {
        out.push({ label: `${dir}/${f}`, path: join(VERSIONS_DIR, dir, f) })
      }
    }
  }
  return out
}

const corpus = listCorpus()

/**
 * The one shipped file the matcher proposes changes to, and exactly what it proposes.
 *
 * Triaged in Phase 4 as a real defect: two walls name the wrong twin — `Core_top_ZN_5_Wall_South`
 * names `Core_bot_…` (the storey below) while its coincident twin names it back. The matcher
 * repoints each to the surface it actually touches, and our validator's four
 * `boundary-asymmetric` errors on the file go to zero. EnergyPlus cannot arbitrate: the file needs
 * an external ASHRAE 205 `.cbor` representation to run at all.
 */
const TRIAGED: Record<string, string[]> = {
  'ASHRAE901_OfficeLarge_STD2019_Denver_Chiller205_Detailed.idf': [
    'Core_top_ZN_5_Wall_South -> Core_top_ZN_5_Wall_South-PPAutoCreateOther',
    'Core_top_ZN_5_Wall_West -> DataCenter_top_ZN_6_Wall_East',
  ],
}

const PAIR_FIELDS = ['Outside Boundary Condition', 'Outside Boundary Condition Object', 'Sun Exposure', 'Wind Exposure']

/** Each surface's pairing fields, lowercased — EnergyPlus reads them case-insensitively. */
function pairingState(doc: IdfDocument, model: Model): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of model.surfaces.values()) {
    const obj = doc.objects.get(s.id)!
    const schema = getSchema(obj.classKey, model.version)
    for (const f of PAIR_FIELDS) {
      const i = schema?.index.get(f.toLowerCase())
      if (i !== undefined) out.set(`${s.name}|${f}`, (obj.fields[i]?.value ?? '').trim().toLowerCase())
    }
  }
  return out
}

function repointings(model: Model, proposals: ReturnType<typeof proposeMatches>['proposals']): string[] {
  return proposals
    .flatMap((p) => p.changes)
    .filter((c) => c.fieldName === 'Outside Boundary Condition Object' && model.surfaces.get(c.objectId)?.kind === 'base')
    .map((c) => `${c.objectName} -> ${c.to}`)
    .sort()
}

describe.skipIf(corpus.length === 0)('Phase 7 gate — auto-matching over the corpus', () => {
  it('proposes nothing on any shipped file except the triaged defect', () => {
    let confirmed = 0
    let unconfirmed = 0
    let intentional = 0
    for (const { label, path } of corpus) {
      const doc = parseIdf(readFileSync(path, 'utf8'))
      const model = buildModel(doc)
      const r = proposeMatches(doc, model)
      confirmed += r.confirmed.length
      unconfirmed += r.unconfirmed.length
      intentional += r.intentional.length
      const file = label.split('/').pop()!
      expect(repointings(model, r.proposals), label).toEqual((TRIAGED[file] ?? []).slice().sort())
      expect(r.partial, `${label}: partial overlaps flagged`).toEqual([])
    }
    expect(confirmed).toBeGreaterThan(1500)
    console.log(
      `match: ${corpus.length} files — ${confirmed} declared pairs confirmed, ${unconfirmed} declared ` +
        `but not coincident (left alone), ${intentional} coincident with a deliberate boundary (left ` +
        `alone), proposals only on the triaged defect`,
    )
  })

  it('strips every confirmed pair in every file, and proposes exactly those pairs back', () => {
    let stripped = 0
    let files = 0
    for (const { label, path } of corpus) {
      const source = readFileSync(path, 'utf8')
      const doc = parseIdf(source)
      const model = buildModel(doc)
      const original = proposeMatches(doc, model)
      if (original.confirmed.length === 0) continue
      const before = pairingState(doc, model)

      const set = (id: string, field: string, value: string): void => {
        const obj = doc.objects.get(id)!
        const i = getSchema(obj.classKey, model.version)!.index.get(field.toLowerCase())
        if (i !== undefined) setFieldValue(doc, model, id, i, value)
      }
      const expected = new Set<string>()
      for (const { a, b } of original.confirmed) {
        for (const id of [a, b]) {
          set(id, 'Outside Boundary Condition', 'Outdoors')
          set(id, 'Outside Boundary Condition Object', '')
          set(id, 'Sun Exposure', 'SunExposed')
          set(id, 'Wind Exposure', 'WindExposed')
          const s = model.surfaces.get(id)!
          if (s.kind === 'base') for (const sub of s.subSurfaces) set(sub, 'Outside Boundary Condition Object', '')
        }
        expected.add(`${model.surfaces.get(a)!.name}|${model.surfaces.get(b)!.name}`)
      }

      // Round-trip through text, so the matcher sees exactly what a user reopening the file would.
      const brokenDoc = parseIdf(emitIdf(doc))
      const brokenModel = buildModel(brokenDoc)
      const r = proposeMatches(brokenDoc, brokenModel)
      const proposed = r.proposals.map((p) => `${brokenModel.surfaces.get(p.a)!.name}|${brokenModel.surfaces.get(p.b)!.name}`)
      const file = label.split('/').pop()!
      const triaged = TRIAGED[file] ?? []

      expect(proposed.filter((k) => !expected.has(k)).length, `${label}: proposed beyond what was broken`).toBe(triaged.length)
      expect([...expected].filter((k) => !proposed.includes(k)), `${label}: failed to propose`).toEqual([])

      applyMatchProposals(brokenDoc, brokenModel, r.proposals)
      const restoredDoc = parseIdf(emitIdf(brokenDoc))
      const after = pairingState(restoredDoc, buildModel(restoredDoc))
      const differ = [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k.split('|')[0]!)
      // Only the triaged defect's surfaces may end up different from the file as shipped.
      expect(differ.sort(), label).toEqual(triaged.map((t) => t.split(' -> ')[0]!).sort())

      stripped += expected.size
      files++
    }
    expect(stripped).toBeGreaterThan(1500)
    console.log(`match: stripped and restored ${stripped} interzone pairs across ${files} files, every field as shipped`)
  })
})
