import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, getSchema, setFieldValue, type Model } from '../../src/model/index.js'
import { applyMatchProposals, proposeMatches } from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff, type EnergyPlusRun } from '../harness/energyplus.js'
import { canRun, exe, PAIRED_FILES, readFixture } from '../harness/gate-fixtures.js'

/**
 * PHASE 7 GATE — EnergyPlus half.
 *
 * Break a paired fixture's pairing three ways, let the matcher propose, accept everything it
 * proposes, and require the repaired file to run exactly as the shipped one did: no new severe,
 * and warnings identical as text.
 *
 * The three breaks differ in who notices, which is the point of measuring all three:
 *
 *   - **one-sided** (one side's boundary reset to `Outdoors`) and **dangling** (a twin name that
 *     does not exist): EnergyPlus refuses to run. That is the control — the harness can fail.
 *   - **stripped** (every pair reset to `Outdoors` on both sides): EnergyPlus runs, and says
 *     nothing. Internal partitions become exterior walls and the physics is silently wrong.
 *     Only air-boundary constructions, which EnergyPlus insists be interzone, give it away.
 *     This is the class of error only geometry can catch.
 */

type Break = 'one-sided' | 'dangling' | 'stripped'

function breakPairs(doc: IdfDocument, model: Model, how: Break): number {
  const r = proposeMatches(doc, model)
  const set = (id: string, field: string, value: string): void => {
    const obj = doc.objects.get(id)!
    const i = getSchema(obj.classKey, model.version)!.index.get(field.toLowerCase())
    if (i !== undefined) setFieldValue(doc, model, id, i, value)
  }
  const expose = (id: string): void => {
    set(id, 'Outside Boundary Condition', 'Outdoors')
    set(id, 'Outside Boundary Condition Object', '')
    set(id, 'Sun Exposure', 'SunExposed')
    set(id, 'Wind Exposure', 'WindExposed')
  }
  const targets = how === 'stripped' ? r.confirmed : r.confirmed.slice(0, 1)
  for (const { a, b } of targets) {
    if (how === 'stripped') {
      expose(a)
      expose(b)
    } else if (how === 'one-sided') {
      expose(b)
    } else {
      set(a, 'Outside Boundary Condition Object', 'NoSuchSurface')
    }
  }
  return targets.length
}

describe.skipIf(!canRun || PAIRED_FILES.length === 0)('Phase 7 gate — EnergyPlus accepts every repair', () => {
  const baselines = new Map<string, EnergyPlusRun>()
  const base = (file: string): EnergyPlusRun => {
    let run = baselines.get(file)
    if (!run) {
      run = runEnergyPlus(exe!, readFixture(file), { workdir: `match/${file}/base` })
      expect(run.severes, `${file} baseline is not clean`).toEqual([])
      baselines.set(file, run)
    }
    return run
  }

  for (const file of PAIRED_FILES) {
    for (const how of ['one-sided', 'dangling', 'stripped'] as const) {
      it(
        `${file}: ${how} pairing is proposed back, and the repair runs as shipped`,
        () => {
          const doc = parseIdf(readFixture(file))
          const model = buildModel(doc)
          const broken = breakPairs(doc, model, how)
          const brokenText = emitIdf(doc)
          const brokenRun = runEnergyPlus(exe!, brokenText, { workdir: `match/${file}/${how}-broken` })

          if (how !== 'stripped') {
            expect(brokenRun.completed, `${file}: E+ accepted a ${how} pair`).toBe(false)
          }

          const brokenDoc = parseIdf(brokenText)
          const brokenModel = buildModel(brokenDoc)
          const r = proposeMatches(brokenDoc, brokenModel)
          expect(r.proposals, `${file}: one proposal per broken pair, and nothing else`).toHaveLength(broken)
          applyMatchProposals(brokenDoc, brokenModel, r.proposals)

          const repaired = runEnergyPlus(exe!, emitIdf(brokenDoc), { workdir: `match/${file}/${how}-fixed` })
          expect(severeDiff(base(file), repaired).added, repaired.err).toEqual([])
          expect(repaired.completed, repaired.err).toBe(true)
          expect(warningDiff(base(file), repaired), `${file}: warnings differ from the shipped file`).toEqual({
            added: [],
            removed: [],
          })

          console.log(
            `${file}: ${how} ×${broken} — E+ on the broken file: ` +
              (brokenRun.completed
                ? `ran without complaint (${severeDiff(base(file), brokenRun).added.length} new severes)`
                : `refused (${severeDiff(base(file), brokenRun).added[0]})`) +
              `; ${r.proposals.length} proposal(s) accepted; repaired file runs exactly as shipped`,
          )
        },
        180_000,
      )
    }
  }
})
