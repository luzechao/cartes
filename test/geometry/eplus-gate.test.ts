import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import type { Surface } from '../../src/model/index.js'
import {
  moveVertices,
  planCornerMove,
  resolveModel,
  setVertexWorld,
  transformContext,
  validateModel,
  type CornerMovePlan,
} from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff } from '../harness/energyplus.js'
import {
  available,
  canRun,
  exe,
  FIXTURES,
  inPlaneMove,
  modelOf,
  MOVE_DISTANCE,
  partitionSevere,
  readFixture,
  pickEditableSurface,
  TIER3_ONLY_FILE,
} from '../harness/gate-fixtures.js'

/**
 * PHASE 6 GATE (docs/05-implementation-plan.md)
 *
 *   Move a vertex -> validation still passes -> EnergyPlus runs the output file without new
 *   severe errors.
 *
 * Fixture selection, exclusions and the reasons for both live in `harness/gate-fixtures.ts`.
 * The referential-integrity half of the gate — paired surfaces and deletion — is in
 * `eplus-refs.test.ts`.
 */

function errorCodes(model: Model, doc: ReturnType<typeof parseIdf>): string[] {
  const report = validateModel(model, resolveModel(model), doc)
  return report.issues
    .filter((i) => i.severity === 'error')
    .map((i) => `${i.code}:${i.objectId ?? ''}`)
    .sort()
}

describe.skipIf(!canRun)('Phase 6 gate — EnergyPlus accepts an edited vertex', () => {
  it('found an EnergyPlus binary', () => {
    expect(exe, 'no EnergyPlus binary resolved').toBeTruthy()
    console.log(`EnergyPlus: ${exe}`)
  })

  for (const file of available) {
    it(
      `${file}: moving a vertex introduces no new severe errors`,
      () => {
        const source = readFixture(file)

        // --- baseline -------------------------------------------------------
        const baseDoc = parseIdf(source)
        const baseModel = buildModel(baseDoc)
        const baseErrors = errorCodes(baseModel, baseDoc)
        const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/base` })

        expect(baseRun.completed, `${file} baseline did not complete:\n${baseRun.err}`).toBe(true)
        expect(baseRun.severes, `${file} baseline is not clean`).toEqual([])

        // --- edit -----------------------------------------------------------
        const doc = parseIdf(source)
        const model = buildModel(doc)
        const ctx = transformContext(model)
        const resolved = resolveModel(model)

        const surface = pickEditableSurface(model)
        expect(surface, `${file} has no unconstrained surface to edit`).toBeTruthy()

        const r = resolved.get(surface!.id)!
        const target = inPlaneMove(r.worldVertices[0]!, r.worldVertices[1]!)
        expect(target, `${file}: ${surface!.name} edge 0->1 is too short to move along`).toBeTruthy()

        const result = setVertexWorld(doc, model, surface!.id, 0, target!, ctx)
        expect(result.changed, `${file}: the edit was a no-op, so this proves nothing`).toBe(true)

        // Exactly one object dirty — the Phase 5 invariant must survive geometry edits.
        const dirty = [...doc.objects.values()].filter((o) => o.dirty).map((o) => o.id)
        expect(dirty).toEqual([surface!.id])

        const edited = emitIdf(doc)
        expect(edited, `${file}: emitted text is unchanged`).not.toBe(source)

        // --- validation still passes ---------------------------------------
        const editedDoc = parseIdf(edited)
        const editedModel = buildModel(editedDoc)
        const newErrors = errorCodes(editedModel, editedDoc).filter((c) => !baseErrors.includes(c))
        expect(newErrors, `${file}: the edit introduced validation errors`).toEqual([])

        // --- EnergyPlus still accepts it ------------------------------------
        const editedRun = runEnergyPlus(exe!, edited, { workdir: `${file}/edited` })
        const { geometric, thermal } = partitionSevere(severeDiff(baseRun, editedRun).added)

        expect(
          geometric,
          `${file}: editing ${surface!.name} introduced severe errors:\n${editedRun.err}`,
        ).toEqual([])
        expect(editedRun.completed, `${file} edited run did not complete:\n${editedRun.err}`).toBe(
          true,
        )

        console.log(
          `${file}: moved ${surface!.name} vertex 1 by ${MOVE_DISTANCE} m in-plane — ` +
            `E+ completed, ${editedRun.warningCount} warnings (baseline ${baseRun.warningCount}), 0 new severes` +
            (thermal.length > 0 ? ` [non-geometric: ${thermal.join('; ')}]` : ''),
        )
      },
      120_000,
    )
  }
})

/**
 * Find a plan-view corner that `planCornerMove` reports as coherent.
 *
 * The decision of *what* is coherent belongs to product code, not to this test — that was a
 * recorded weakness of the first version of this gate, which reimplemented the rule here and
 * so tested a parallel implementation rather than the shipping one. All this helper does now
 * is enumerate candidate positions and ask.
 */
function findCoherentCorner(
  model: Model,
  resolved: ReturnType<typeof resolveModel>,
): { x: number; y: number; plan: CornerMovePlan } | undefined {
  const seen = new Set<string>()

  for (const r of resolved.values()) {
    for (const v of r.worldVertices) {
      const key = `${Math.round(v.x / 1e-6)},${Math.round(v.y / 1e-6)}`
      if (seen.has(key)) continue
      seen.add(key)

      const plan = planCornerMove(model, resolved, v.x, v.y)
      // Fewer than three incident vertices is not a building corner.
      if (plan.coherent && plan.members.length >= 3) return { x: v.x, y: v.y, plan }
    }
  }
  return undefined
}

describe.skipIf(!canRun)('Phase 6 gate — a coherent corner move preserves the enclosure', () => {
  /**
   * The single-vertex gate above passes on severes but measurably adds one warning:
   * `CalculateZoneVolume: N zone is not fully enclosed`. That is the whole argument for
   * snapping. This test performs the operation snapping exists to enable — moving every
   * vertex coincident with a corner by the same delta — and asserts the stronger result: not
   * just no new severes, but *no new warnings at all*.
   *
   * The delta is horizontal on purpose. A vertical component would drag the corner of every
   * flat roof and floor meeting the wall out of its own plane, which EnergyPlus reports as
   * `ProcessSurfaceVertices: Suspected non-planar surface`; `eplus-refs.test.ts` measures that
   * case. `planCornerMove` is a plan-view operation and its name says so.
   */
  const DELTA = { x: 0.05, y: 0.05, z: 0 }
  let exercised = 0

  for (const file of available) {
    it(
      `${file}: moving a whole corner adds no warnings`,
      (context) => {
        const source = readFixture(file)
        const doc = parseIdf(source)
        const model = buildModel(doc)
        const ctx = transformContext(model)
        const resolved = resolveModel(model)

        const corner = findCoherentCorner(model, resolved)
        if (!corner) {
          context.skip(`${file} has no coherent corner`)
          return
        }

        const result = moveVertices(doc, model, resolved, corner.plan.members, DELTA, ctx)
        expect(result.changed).toBe(true)

        const edited = emitIdf(doc)
        expect(edited).not.toBe(source)

        // Every moved surface must still be planar, or the comparison below would be
        // measuring our own broken geometry rather than the enclosure.
        const editedModel = buildModel(parseIdf(edited))
        const editedResolved = resolveModel(editedModel)
        for (const { surfaceId } of corner.plan.members) {
          const name = model.surfaces.get(surfaceId)!.name
          const after = [...editedResolved.entries()].find(
            ([id]) => editedModel.surfaces.get(id)?.name === name,
          )
          expect(after![1].planarityError, `${name} became non-planar`).toBeLessThan(1e-6)
        }

        const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/corner-base` })
        const editedRun = runEnergyPlus(exe!, edited, { workdir: `${file}/corner-edited` })
        const { geometric, thermal } = partitionSevere(severeDiff(baseRun, editedRun).added)

        expect(geometric, `${file}:\n${editedRun.err}`).toEqual([])
        expect(editedRun.completed).toBe(true)

        // Compared as text, not as a count: a count can hold still while one warning is
        // traded for another, which is exactly the case this test must not miss.
        expect(
          warningDiff(baseRun, editedRun).added,
          `${file}: moving the whole corner still introduced warnings —\n${editedRun.err}`,
        ).toEqual([])

        exercised++
        console.log(
          `${file}: moved a corner shared by ${corner.plan.members.length} vertices by 50 mm — ` +
            `E+ completed, ${editedRun.warningCount} warnings (baseline ${baseRun.warningCount}), 0 new severes` +
            (thermal.length > 0 ? ` [non-geometric: ${thermal.join('; ')}]` : ''),
        )
      },
      120_000,
    )
  }

  it('exercised the corner move on at least one fixture', () => {
    expect(exercised, 'no fixture offered a corner free of fenestration').toBeGreaterThan(0)
  })
})

describe.skipIf(!canRun)('Phase 6 gate — the harness itself', () => {
  it(
    'detects a severe error that our edit really did cause',
    () => {
      // A negative control. If the harness cannot see a break this obvious, a clean result on
      // the real gate above means nothing.
      const file = available[0]!
      const source = readFixture(file)

      const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/control-base` })
      expect(baseRun.severes).toEqual([])

      const doc = parseIdf(source)
      const model = buildModel(doc)
      const surface = [...model.surfaces.values()].find((s) => s.kind === 'base')!
      const obj = doc.objects.get(surface.id)!
      // Point the construction at something that does not exist.
      const constructionField = obj.fields[2]!
      constructionField.value = 'NoSuchConstruction'
      obj.dirty = true

      const broken = runEnergyPlus(exe!, emitIdf(doc), { workdir: `${file}/control-broken` })
      const diff = severeDiff(baseRun, broken)
      expect(
        diff.added.length,
        'harness saw no new severe for a dangling construction',
      ).toBeGreaterThan(0)
    },
    120_000,
  )
})

describe.skipIf(!existsSync(join(FIXTURES, TIER3_ONLY_FILE)))('Phase 6 gate — exclusions', () => {
  it('excludes the tier-3-only fixture because it has no vertex to move', () => {
    const model = modelOf(TIER3_ONLY_FILE)

    // Not "no surfaces we happened to pick" but "no surfaces carrying vertices at all":
    // every surface in this file is a rectangular class defined by azimuth, tilt, length and
    // height. Phase 6 has nothing to edit here, and says so out loud.
    const withVertices = [...model.surfaces.values()].filter((s: Surface) => s.vertices.length > 0)
    expect(withVertices).toEqual([])
    expect(pickEditableSurface(model)).toBeUndefined()
  })
})
