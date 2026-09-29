import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  planSurfaceDeletion,
} from '../../src/model/index.js'
import {
  moveVertices,
  planCornerMove,
  resolveModel,
  setVertexWorld,
  transformContext,
  validateModel,
  verticesAt,
} from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff } from '../harness/energyplus.js'
import {
  canRun,
  cornerCandidates,
  exe,
  inPlaneMove,
  interzonePairs,
  modelOf,
  PAIRED_FILES,
  partitionSevere,
  readFixture,
} from '../harness/gate-fixtures.js'

/**
 * PHASE 6 GATE — referential integrity (docs/05-implementation-plan.md)
 *
 *   "Referential integrity is the hazard. Any edit touching a surface with
 *    `Outside Boundary Condition = Surface` must either update the twin or flag the break.
 *    Never leave a dangling `Outside Boundary Condition Object`."
 *
 * `eplus-gate.test.ts` deliberately edits unconstrained surfaces, so on its own it would not
 * be evidence that the hazard is handled. This file does the opposite: every surface it
 * touches is chosen *because* it is one half of an interzone pair.
 *
 * Each claim is paired with its own control. "EnergyPlus was happy" means nothing unless the
 * same harness can be shown to make EnergyPlus unhappy on the case the code exists to
 * prevent, so both directions are asserted throughout.
 */

const COINCIDENT = 1e-6

describe.skipIf(PAIRED_FILES.length === 0)(
  'Phase 6 — a corner move never half-moves an interzone pair',
  () => {
    /**
     * The structural half of the claim, checked on every corner of every paired fixture rather
     * than on the single corner the EnergyPlus tests happen to pick. No simulation is
     * involved, so it is free to be exhaustive.
     *
     * The first version of this test assumed two paired surfaces must share a perimeter and so
     * would always be gathered together by plan-view coincidence. `Plenum.idf` disproved it:
     * its zones are drawn at their inside faces, 36 mm apart. So the guarantee asserted here
     * is the weaker but true one — a pair is either moved on both sides, or the split is
     * reported in `splitPairs`. It is never split silently.
     */
    let corpusTogether = 0
    let corpusReported = 0

    for (const file of PAIRED_FILES) {
      it(`${file}: both sides of every pair move together, or the split is reported`, () => {
        const model = modelOf(file)
        const resolved = resolveModel(model)
        const pairs = interzonePairs(model)

        let coherent = 0
        let together = 0
        let reported = 0

        for (const { x, y } of cornerCandidates(resolved)) {
          const plan = planCornerMove(model, resolved, x, y)
          if (!plan.coherent) continue
          coherent++

          const moved = new Set(plan.members.map((m) => m.surfaceId))
          const flagged = new Set(plan.splitPairs.map((s) => `${s.surfaceId}>${s.twinId}`))

          for (const pair of pairs) {
            const a = moved.has(pair.id)
            const b = moved.has(pair.twinId)
            if (a && b) {
              together++
              continue
            }
            if (!a && !b) continue

            // One side moves and the other does not. That is permitted, but only if the plan
            // said so; an unreported split is the failure this test exists to catch.
            const half = a ? pair : { ...pair, id: pair.twinId, twinId: pair.id }
            expect(
              flagged.has(`${half.id}>${half.twinId}`),
              `at (${x}, ${y}) the plan moves one side of ${pair.name}/${pair.twinName} ` +
                `without reporting the split`,
            ).toBe(true)
            reported++
          }
        }

        expect(coherent, `${file} offered no coherent corner`).toBeGreaterThan(0)
        corpusTogether += together
        corpusReported += reported

        const offset = pairs.filter((p) => p.gap > COINCIDENT)
        console.log(
          `${file}: ${coherent} coherent corners, ${pairs.length} pairs ` +
            `(${offset.length} geometrically offset, max gap ` +
            `${Math.max(0, ...pairs.map((p) => p.gap)).toFixed(4)} m) — ` +
            `${together} moved on both sides, ${reported} splits reported`,
        )
      })
    }

    it('the corpus exercises both outcomes', () => {
      // Without this the suite above could pass by never moving a pair at all, or by never
      // meeting the offset case `splitPairs` was written for.
      expect(
        corpusTogether,
        'no coherent corner anywhere moved both sides of a pair',
      ).toBeGreaterThan(0)
      expect(
        corpusReported,
        'no corner anywhere reported a split pair, so that check is dead code',
      ).toBeGreaterThan(0)
    })
  },
)

describe.skipIf(!canRun || PAIRED_FILES.length === 0)(
  'Phase 6 gate — EnergyPlus on paired surfaces',
  () => {
    /**
     * The control for the corner test's "no new warnings" result.
     *
     * That result is only evidence if EnergyPlus would have complained about the alternative,
     * so here is the alternative: move one side of an interzone pair and leave its twin where
     * it was. This is the failure mode a naive vertex editor falls into by default, and it is
     * what the corner logic exists to prevent.
     */
    for (const file of PAIRED_FILES) {
      it(
        `${file}: EnergyPlus notices when only one side of a pair moves`,
        (context) => {
          const source = readFixture(file)
          const doc = parseIdf(source)
          const model = buildModel(doc)
          const pair = interzonePairs(model).find((p) => !p.fenestrated)
          if (!pair) {
            context.skip(`${file} has no fenestration-free interzone pair`)
            return
          }

          const resolved = resolveModel(model)
          const ctx = transformContext(model)
          const vs = resolved.get(pair.id)!.worldVertices
          const target = inPlaneMove(vs[0]!, vs[1]!)
          expect(target, `${file}: ${pair.name} edge 0->1 is too short`).toBeTruthy()

          expect(setVertexWorld(doc, model, pair.id, 0, target!, ctx).changed).toBe(true)

          // Only the one surface changed — the twin was deliberately left behind.
          const dirty = [...doc.objects.values()].filter((o) => o.dirty).map((o) => o.id)
          expect(dirty).toEqual([pair.id])

          const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/pair-base` })
          const editedRun = runEnergyPlus(exe!, emitIdf(doc), { workdir: `${file}/pair-split` })

          const added = warningDiff(baseRun, editedRun).added
          expect(
            added.length,
            `${file}: splitting ${pair.name} from ${pair.twinName} produced no new warning, so ` +
              `the corner test's clean result is not evidence of anything:\n${editedRun.err}`,
          ).toBeGreaterThan(0)

          console.log(
            `${file}: moved ${pair.name} but not twin ${pair.twinName} — E+ warned: ` +
              added.map((m) => m.slice(0, 100)).join(' | '),
          )
        },
        120_000,
      )
    }

    /**
     * The control for `CornerMovePlan.splitPairs` — and for the decision not to let it veto.
     *
     * `Plenum.idf` draws each zone at its inside face, so `Zn001:Wall004` and its named twin
     * `Zn002:Wall004` are 36 mm apart and plan-view coincidence gathers only one of them.
     * Moving one side without the other gives the two faces of the partition different areas.
     *
     * Measured: EnergyPlus does not care at 50 mm or at 250 mm, and does care at 1 m, where it
     * reports `InterZone Surface Areas do not match as expected`. That is why `splitPairs` is
     * reported rather than refused, and it is why this test moves a whole metre — a 50 mm
     * version of it would pass while asserting nothing.
     */
    const SPLIT_PAIR_THRESHOLD = 1.0

    for (const file of PAIRED_FILES) {
      it(
        `${file}: a reported split pair is a real divergence, not a scruple`,
        (context) => {
          const source = readFixture(file)
          const doc = parseIdf(source)
          const model = buildModel(doc)
          const resolved = resolveModel(model)
          const ctx = transformContext(model)

          const found = cornerCandidates(resolved)
            .map((c) => ({ ...c, plan: planCornerMove(model, resolved, c.x, c.y) }))
            .find((c) => c.plan.coherent && c.plan.splitPairs.length > 0)
          if (!found) {
            context.skip(`${file} has no coherent corner that splits a pair`)
            return
          }

          const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/split-base` })
          const delta = { x: SPLIT_PAIR_THRESHOLD, y: SPLIT_PAIR_THRESHOLD, z: 0 }
          expect(moveVertices(doc, model, resolved, found.plan.members, delta, ctx).changed).toBe(
            true,
          )
          const editedRun = runEnergyPlus(exe!, emitIdf(doc), { workdir: `${file}/split-applied` })

          const added = warningDiff(baseRun, editedRun).added
          const mismatch = added.find((m) => /InterZone Surface Areas do not match/i.test(m))
          expect(
            mismatch,
            `${file}: moving one side of a reported split pair by ${SPLIT_PAIR_THRESHOLD} m ` +
              `produced no interzone complaint, so reporting the split is pointless:\n` +
              editedRun.err,
          ).toBeTruthy()

          const split = found.plan.splitPairs[0]!
          console.log(
            `${file}: moved ${split.surfaceName} without twin ${split.twinName} by ` +
              `${SPLIT_PAIR_THRESHOLD} m — E+: ${added.map((m) => m.slice(0, 80)).join(' | ')}`,
          )
        },
        120_000,
      )
    }

    /**
     * Vertex coincidence in three dimensions is *not* a sufficient basis for a drag.
     *
     * Measured: taking every vertex coincident with a wall-top corner and moving the set
     * vertically keeps the walls consistent with each other and with their twins, and still
     * produces a broken file — because the flat roof and floor corners in that same set leave
     * their own planes. EnergyPlus reports `ProcessSurfaceVertices: Suspected non-planar
     * surface`.
     *
     * The point is not that the operation fails; it is that *we say so first*. The validator
     * names the same surfaces EnergyPlus does, before the file is ever run, which is the
     * contract the whole editor rests on.
     */
    for (const file of PAIRED_FILES) {
      it(
        `${file}: a vertical coincident-vertex move is caught by us before EnergyPlus`,
        (context) => {
          const source = readFixture(file)
          const doc = parseIdf(source)
          const model = buildModel(doc)
          // Needs a pair that really is coincident, or there is no shared vertex to drag and
          // the twin would not be involved at all.
          const pair = interzonePairs(model).find((p) => !p.fenestrated && p.gap <= COINCIDENT)
          if (!pair) {
            context.skip(`${file} has no coincident, fenestration-free interzone pair`)
            return
          }

          const resolved = resolveModel(model)
          const ctx = transformContext(model)
          const corner = resolved.get(pair.id)!.worldVertices[0]!

          const members = verticesAt(resolved, corner)
          expect(members.map((m) => m.surfaceId)).toContain(pair.twinId)

          expect(
            moveVertices(doc, model, resolved, members, { x: 0, y: 0, z: -0.05 }, ctx).changed,
          ).toBe(true)

          // --- what we say, with nothing run ------------------------------
          const editedDoc = parseIdf(emitIdf(doc))
          const editedModel = buildModel(editedDoc)
          const ours = validateModel(editedModel, resolveModel(editedModel), editedDoc)
            .issues.filter((i) => i.code === 'surface-non-planar')
            .map((i) => editedModel.surfaces.get(i.objectId ?? '')?.name?.toLowerCase())
            .filter((n): n is string => n !== undefined)

          expect(
            ours.length,
            `${file}: we reported no non-planarity for a vertical corner drag`,
          ).toBeGreaterThan(0)

          // --- what EnergyPlus says ---------------------------------------
          const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/vert-base` })
          const editedRun = runEnergyPlus(exe!, emitIdf(doc), { workdir: `${file}/vert-edited` })
          const theirs = severeDiff(baseRun, editedRun).added.filter((m) =>
            /Suspected non-planar surface/i.test(m),
          )

          expect(
            theirs.length,
            `${file}: EnergyPlus did not object, so our error is a false positive:\n${editedRun.err}`,
          ).toBeGreaterThan(0)

          // Same surfaces, not merely the same number of complaints.
          for (const message of theirs) {
            const named = ours.some((name) => message.toLowerCase().includes(`"${name}"`))
            expect(
              named,
              `${file}: E+ blamed a surface we did not:\n  ${message}\n  ours: ${ours.join(', ')}`,
            ).toBe(true)
          }

          console.log(
            `${file}: vertical drag of ${members.length} coincident vertices — ` +
              `we flagged ${ours.length} non-planar surface(s), E+ flagged ${theirs.length}, same surfaces`,
          )
        },
        120_000,
      )
    }

    /**
     * The positive control for `model/delete.ts`'s refusal to repair twins silently.
     *
     * The module leaves an orphaned twin pointing at a surface that no longer exists, on the
     * grounds that the user should see the break rather than have it papered over — expressly
     * rejecting VI-Suite's silent downgrade to `Adiabatic`. That is only defensible if the
     * break is real *and* we report it. Both halves are asserted: our validator raises
     * `boundary-missing-object`, and EnergyPlus independently refuses to run the file at all.
     */
    for (const file of PAIRED_FILES) {
      it(
        `${file}: an unrepaired twin is fatal to EnergyPlus, and our validator says so first`,
        () => {
          const source = readFixture(file)
          const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/del-base` })
          expect(baseRun.completed).toBe(true)

          const doc = parseIdf(source)
          const model = buildModel(doc)
          const pair = interzonePairs(model)[0]!
          const refs = buildReferenceIndex(doc, model.version)

          const plan = planSurfaceDeletion(doc, model, refs, pair.id)!
          expect(plan.twins.map((t) => t.name)).toContain(pair.twinName)

          applySurfaceDeletion(doc, model, plan) // default: twins = 'leave'
          const edited = emitIdf(doc)

          // --- our validator, before anything is run ------------------------
          const editedDoc = parseIdf(edited)
          const editedModel = buildModel(editedDoc)
          const dangling = validateModel(
            editedModel,
            resolveModel(editedModel),
            editedDoc,
          ).issues.filter((i) => i.code === 'boundary-missing-object')
          expect(
            dangling.length,
            `${file}: deleted ${pair.name} without reporting ${pair.twinName} as dangling`,
          ).toBeGreaterThan(0)

          // --- EnergyPlus ---------------------------------------------------
          const editedRun = runEnergyPlus(exe!, edited, { workdir: `${file}/del-leave` })
          expect(
            editedRun.completed,
            `${file}: EnergyPlus accepted a dangling boundary reference, so "leave" is not the ` +
              `honest default we claim it is:\n${editedRun.err}`,
          ).toBe(false)

          const complaint = severeDiff(baseRun, editedRun).added.find((m) =>
            /references an outside boundary surface that cannot be found/i.test(m),
          )
          expect(
            complaint,
            `${file}: E+ failed, but for some other reason:\n${editedRun.err}`,
          ).toBeTruthy()
          expect(complaint!.toLowerCase()).toContain(pair.name.toLowerCase())

          console.log(`${file}: deleted ${pair.name}, twin left — E+: ${complaint}`)
        },
        120_000,
      )
    }

    /**
     * The other side of that decision: asking for the repair by name produces a file that runs.
     *
     * The only new severe errors tolerated are ones the plan predicted through
     * `undeclaredMentions`. That clause is not a loophole — it is the assertion that found the
     * gap it now covers. `5ZoneAirCooled_AirBoundaries.idf` names surfaces as `Meter:Custom`
     * key names; `Meter:Custom` is outside the schema subset the model layer loads, so
     * `buildReferenceIndex` was skipping the object entirely and the deletion reported clean
     * before raising two severes in the simulation. Both the textual sweep and this assertion
     * exist because of that measurement.
     */
    for (const file of PAIRED_FILES) {
      it(
        `${file}: repairing the twin to Adiabatic makes the deletion run`,
        () => {
          const source = readFixture(file)
          const baseRun = runEnergyPlus(exe!, source, { workdir: `${file}/adia-base` })

          const doc = parseIdf(source)
          const model = buildModel(doc)
          const pair = interzonePairs(model)[0]!
          const refs = buildReferenceIndex(doc, model.version)
          const plan = planSurfaceDeletion(doc, model, refs, pair.id)!

          // Names of the objects the plan flagged, captured before the document is mutated.
          const flagged = plan.undeclaredMentions
            .map((r) => (doc.objects.get(r.fromId)?.fields[0]?.value ?? '').trim().toLowerCase())
            .filter((n) => n !== '')

          const twin = plan.twins.find((t) => t.name === pair.twinName)!
          const result = applySurfaceDeletion(doc, model, plan, { twins: 'adiabatic' })
          expect(result.repairedTwins).toContain(twin.id)

          const editedRun = runEnergyPlus(exe!, emitIdf(doc), { workdir: `${file}/del-adiabatic` })
          expect(
            editedRun.completed,
            `${file}: the repaired deletion still did not run:\n${editedRun.err}`,
          ).toBe(true)

          const { geometric } = partitionSevere(severeDiff(baseRun, editedRun).added)
          const unexplained = geometric.filter(
            (m) => !flagged.some((name) => m.toLowerCase().includes(name)),
          )
          expect(
            unexplained,
            `${file}: deleting ${pair.name} caused severe errors the plan did not predict:\n` +
              editedRun.err,
          ).toEqual([])

          const predicted = geometric.length - unexplained.length
          console.log(
            `${file}: deleted ${pair.name}, twin ${pair.twinName} -> Adiabatic — E+ completed` +
              (predicted > 0
                ? `; ${predicted} severe(s), each traced to one of the ` +
                  `${plan.undeclaredMentions.length} undeclared mention(s) the plan warned about`
                : ''),
          )
        },
        120_000,
      )
    }
  },
)
