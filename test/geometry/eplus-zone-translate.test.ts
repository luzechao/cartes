import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import {
  applyZoneTranslation,
  planZoneTranslation,
  resolveModel,
  validateModel,
  type ZoneTranslationPlan,
} from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff, type EnergyPlusRun } from '../harness/energyplus.js'
import { available, canRun, exe, partitionSevere, readFixture } from '../harness/gate-fixtures.js'

/**
 * PHASE 6 GATE — whole-zone translate (docs/05-implementation-plan.md)
 *
 * Every zone of every gate fixture is moved, and EnergyPlus must add nothing: no severe and —
 * stricter than the vertex gate — no warning either, compared as text. A rigid translation of
 * a whole zone preserves every area, every adjacency *within* the zone and every relationship
 * EnergyPlus checks, so anything it adds is our bug.
 *
 * The control is the daylighting half. `PurchAirWithDaylighting.idf` is World throughout, so its
 * reference points and illuminance map carry absolute coordinates that do not follow the zone
 * unless the translate moves them explicitly. Leave them behind and EnergyPlus says so.
 */

const DELTA = { x: 3, y: -2, z: 0.5 }

function errorCodes(text: string): string[] {
  const m = buildModel(parseIdf(text))
  return validateModel(m, resolveModel(m))
    .issues.filter((i) => i.severity === 'error')
    .map((i) => `${i.code}:${m.surfaces.get(i.objectId ?? '')?.name ?? i.objectId ?? ''}`)
    .sort()
}

function translated(
  source: string,
  zoneName: string,
  tamper?: (plan: ZoneTranslationPlan) => void,
): { text: string; plan: ZoneTranslationPlan; dirtied: string[]; model: Model } {
  const doc = parseIdf(source)
  const model = buildModel(doc)
  const zone = [...model.zones.values()].find((z) => z.name === zoneName)!
  const plan = planZoneTranslation(doc, model, zone.id, DELTA)!
  tamper?.(plan)
  const { dirtied } = applyZoneTranslation(doc, model, plan)
  return { text: emitIdf(doc), plan, dirtied, model }
}

describe.skipIf(!canRun)('Phase 6 gate — whole-zone translate', () => {
  const baselines = new Map<string, EnergyPlusRun>()
  const base = (file: string): EnergyPlusRun => {
    let run = baselines.get(file)
    if (!run) {
      run = runEnergyPlus(exe!, readFixture(file), { workdir: `zone/${file}/base` })
      expect(run.severes, `${file} baseline is not clean`).toEqual([])
      baselines.set(file, run)
    }
    return run
  }

  for (const file of available) {
    it(
      `${file}: every zone moves with no new severe, warning or validation error`,
      () => {
        const source = readFixture(file)
        const baseErrors = errorCodes(source)
        const zones = [...buildModel(parseIdf(source)).zones.values()].map((z) => z.name)
        expect(zones.length).toBeGreaterThan(0)

        const summary: string[] = []
        zones.forEach((zoneName, i) => {
          const { text, plan, dirtied, model } = translated(source, zoneName)
          expect(dirtied.length, `${file} ${zoneName}: nothing moved`).toBeGreaterThan(0)
          expect(plan.leftBehind, `${file} ${zoneName}`).toEqual([])

          if (model.rules.coordinateSystem === 'Relative' && plan.daylighting.length === 0) {
            // The whole zone is one field-level edit to one object.
            expect(dirtied, `${file} ${zoneName}`).toEqual([plan.zoneId])
          }

          const newErrors = errorCodes(text).filter((e) => !baseErrors.includes(e))
          expect(newErrors, `${file} ${zoneName}: validation errors`).toEqual([])

          const run = runEnergyPlus(exe!, text, { workdir: `zone/${file}/${i}` })
          const { geometric, thermal } = partitionSevere(severeDiff(base(file), run).added)
          expect(geometric, `${file} ${zoneName}: new severes\n${run.err}`).toEqual([])
          expect(run.completed, run.err).toBe(true)
          expect(warningDiff(base(file), run).added, `${file} ${zoneName}: new warnings`).toEqual([])

          summary.push(
            `${zoneName} (${dirtied.length} object${dirtied.length === 1 ? '' : 's'}` +
              `${plan.splitPairs.length ? `, ${plan.splitPairs.length} pairs split` : ''}` +
              `${thermal.length ? ', non-geometric severe' : ''})`,
          )
        })
        console.log(`${file}: translated ${summary.join('; ')} — 0 new severes, 0 new warnings`)
      },
      600_000,
    )
  }

  const DAYLIT = 'PurchAirWithDaylighting.idf'
  it.skipIf(!available.includes(DAYLIT))(
    `${DAYLIT}: daylighting objects left behind are noticed by EnergyPlus`,
    () => {
      const source = readFixture(DAYLIT)
      const zoneName = 'West Zone'

      const good = translated(source, zoneName)
      expect(good.plan.daylighting.length, 'the fixture no longer has daylighting in West Zone').toBeGreaterThan(0)

      const bad = translated(source, zoneName, (plan) => {
        plan.daylighting = []
      })
      const run = runEnergyPlus(exe!, bad.text, { workdir: `zone/${DAYLIT}/left-behind` })
      const added = warningDiff(base(DAYLIT), run).added
      expect(
        added.some((w) => /outside Zone Min\/Max/.test(w)),
        `EnergyPlus did not notice the daylighting objects being left behind:\n${added.join('\n')}`,
      ).toBe(true)
    },
    180_000,
  )
})
