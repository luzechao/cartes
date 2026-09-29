import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import {
  deleteVertex,
  insertVertexWorld,
  resolveModel,
  validateModel,
  type ResolvedSurface,
  type VertexCountEditResult,
} from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff, type EnergyPlusRun } from '../harness/energyplus.js'
import {
  available,
  canRun,
  exe,
  interzonePairs,
  modelOf,
  PAIRED_FILES,
  partitionSevere,
  pickEditableSurface,
  readFixture,
  type InterzonePair,
  type Point3,
} from '../harness/gate-fixtures.js'

/**
 * PHASE 6 GATE — adding and deleting vertices (docs/05-implementation-plan.md)
 *
 * Measured before this file was written, and the reason it is shaped the way it is:
 *
 *   - EnergyPlus deletes collinear vertices on input, with a warning. A vertex inserted on an
 *     edge and left there is therefore invisible to the simulation. Gate 1 asserts exactly that
 *     — the *only* thing a bare split may add is EnergyPlus's own collinear clean-up message.
 *   - A vertex only matters once it leaves the edge. On a zone surface that opens the zone,
 *     because every edge is shared with a neighbour; EnergyPlus says `not fully enclosed`, and
 *     that warning is expected here, not hidden. What is *not* acceptable is a severe error.
 *   - An interzone pair whose sides have different vertex counts is fatal:
 *     `Vertex size mismatch between base surface ... and outside boundary surface`. That is the
 *     control for gates 2 and 3 — mirroring onto the twin is the difference between a file that
 *     runs and one that does not, and our validator names the same two surfaces first.
 */

/** Only EnergyPlus's own collinear-point clean-up. Anything else a bare split adds is a finding. */
const COLLINEAR_CLEANUP = [
  /^GetSurfaceData: There are \d+ coincident\/collinear vertices;/,
  /^CheckConvexity: Surface=".*", vertex \d+ is colinear with previous and next\.$/,
  /^CheckConvexity: Surface=".*" has \[\d+\] collinear points that have been removed\.$/,
  /^CheckConvexity: Surface=".*": The vertex points has been reprocessed as Sides = \d+$/,
]

/** Opening a zone by pulling a shared edge. Expected; see the header. */
const ENCLOSURE = /^CalculateZoneVolume: /

type Edit = (doc: IdfDocument, model: Model) => VertexCountEditResult

interface Outcome {
  result: VertexCountEditResult
  run: EnergyPlusRun
  base: EnergyPlusRun
  ourErrors: Array<{ code: string; name: string }>
}

const baselines = new Map<string, EnergyPlusRun>()

function baseline(file: string): EnergyPlusRun {
  let run = baselines.get(file)
  if (!run) {
    run = runEnergyPlus(exe!, readFixture(file), { workdir: `vcount/${file}/base` })
    expect(run.completed, `${file} baseline did not complete:\n${run.err}`).toBe(true)
    expect(run.severes, `${file} baseline is not clean`).toEqual([])
    baselines.set(file, run)
  }
  return run
}

function attempt(file: string, label: string, edit: Edit): Outcome {
  const doc = parseIdf(readFixture(file))
  const model = buildModel(doc)
  const result = edit(doc, model)
  expect(result.changed, `${file} ${label}: ${result.refused ?? 'no-op'}`).toBe(true)

  const text = emitIdf(doc)
  const edited = buildModel(parseIdf(text))
  const ourErrors = validateModel(edited, resolveModel(edited))
    .issues.filter((i) => i.severity === 'error')
    .map((i) => ({ code: i.code, name: edited.surfaces.get(i.objectId ?? '')?.name ?? '' }))

  const run = runEnergyPlus(exe!, text, { workdir: `vcount/${file}/${label}` })
  return { result, run, base: baseline(file), ourErrors }
}

function midpoint(r: ResolvedSurface, edge: number): Point3 {
  const a = r.worldVertices[edge]!
  const b = r.worldVertices[(edge + 1) % r.worldVertices.length]!
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
}

/** The midpoint of an edge, pulled `distance` into the surface, staying in its plane. */
function pulledMidpoint(r: ResolvedSurface, edge: number, distance: number): Point3 {
  const a = r.worldVertices[edge]!
  const b = r.worldVertices[(edge + 1) % r.worldVertices.length]!
  const n = r.normal
  const e = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  // n x e lies in the plane and, for a counter-clockwise ring, points into the polygon.
  const p = { x: n.y * e.z - n.z * e.y, y: n.z * e.x - n.x * e.z, z: n.x * e.y - n.y * e.x }
  const k = distance / Math.hypot(p.x, p.y, p.z)
  const m = midpoint(r, edge)
  return { x: m.x + p.x * k, y: m.y + p.y * k, z: m.z + p.z * k }
}

/** 300 mm: well clear of E+'s collinearity tolerance, well inside any corpus surface. */
const PULL = 0.3

function firstCleanPair(file: string): InterzonePair | undefined {
  // Coincident (gap 0) so there is something to mirror onto; unfenestrated so that pulling an
  // edge in cannot push a window outside its wall and muddy what is being measured.
  return interzonePairs(modelOf(file)).find((p) => p.gap === 0 && !p.fenestrated)
}

function surfaceNames(errors: Outcome['ourErrors'], code: string): string[] {
  return errors
    .filter((e) => e.code === code)
    .map((e) => e.name.toUpperCase())
    .sort()
}

describe.skipIf(!canRun)('Phase 6 gate — adding and deleting vertices', () => {
  for (const file of available) {
    it(
      `${file}: a bare edge split is invisible to EnergyPlus beyond its collinear clean-up`,
      () => {
        const surface = pickEditableSurface(modelOf(file))!
        const { result, run, base, ourErrors } = attempt(file, 'split', (doc, model) =>
          insertVertexWorld(doc, model, surface.id, 0, midpoint(resolveModel(model).get(surface.id)!, 0)),
        )

        expect(result.dirtied).toEqual([surface.id])
        expect(ourErrors, `${file}: a collinear split raised validation errors`).toEqual([])
        expect(partitionSevere(severeDiff(base, run).added).geometric).toEqual([])
        expect(run.completed, run.err).toBe(true)

        const added = warningDiff(base, run).added
        const unexplained = added.filter((w) => !COLLINEAR_CLEANUP.some((p) => p.test(w)))
        expect(unexplained, `${file}: splitting ${surface.name} added warnings`).toEqual([])
        expect(added.length, `${file}: EnergyPlus did not see the new vertex at all`).toBeGreaterThan(0)
      },
      120_000,
    )
  }

  for (const file of PAIRED_FILES) {
    const pair = firstCleanPair(file)
    if (!pair) continue

    it(
      `${file}: a pulled vertex mirrored onto the twin runs; left off the twin it is fatal`,
      () => {
        const pull = (twin: 'mirror' | 'leave'): Edit => (doc, model) =>
          insertVertexWorld(doc, model, pair.id, 0, pulledMidpoint(resolveModel(model).get(pair.id)!, 0, PULL), {
            twin,
          })

        const good = attempt(file, 'pull-mirror', pull('mirror'))
        expect(good.result.twin).toMatchObject({ id: pair.twinId, mirrored: true })
        expect(good.ourErrors).toEqual([])
        const { geometric, thermal } = partitionSevere(severeDiff(good.base, good.run).added)
        expect(geometric, `${file}: mirrored pull raised severes:\n${good.run.err}`).toEqual([])
        expect(good.run.completed, good.run.err).toBe(true)
        const unexpected = warningDiff(good.base, good.run).added.filter((w) => !ENCLOSURE.test(w))
        expect(unexpected, `${file}: mirrored pull added warnings beyond enclosure`).toEqual([])

        // Control: the same edit, twin left alone.
        const bad = attempt(file, 'pull-leave', pull('leave'))
        expect(bad.run.completed, `${file}: E+ accepted a pair with mismatched vertex counts`).toBe(false)
        const mismatch = severeDiff(bad.base, bad.run).added.filter((s) => /Vertex size mismatch/.test(s))
        const theirs = mismatch.map((s) => /^[^=]+="([^"]+)"/.exec(s)![1]!).sort()
        const ours = surfaceNames(bad.ourErrors, 'paired-vertex-count-mismatch')
        expect(theirs, `${file}: E+ did not report the mismatch`).toEqual(
          [pair.name, pair.twinName].map((n) => n.toUpperCase()).sort(),
        )
        expect(ours, `${file}: our validator and E+ disagree on which surfaces are broken`).toEqual(theirs)

        console.log(
          `${file}: pulled a new vertex ${PULL} m into ${pair.name} — mirrored onto ${pair.twinName}: ` +
            `completes, 0 new severes` +
            (thermal.length > 0 ? ` [non-geometric: ${thermal.length}]` : '') +
            `; not mirrored: E+ fatal on ${theirs.join(' + ')}, which we flag first`,
        )
      },
      180_000,
    )

    it(
      `${file}: a deleted vertex mirrored onto the twin runs; left on the twin it is fatal`,
      () => {
        const del = (twin: 'mirror' | 'leave'): Edit => (doc, model) =>
          deleteVertex(doc, model, pair.id, 0, { twin })

        const good = attempt(file, 'delete-mirror', del('mirror'))
        expect(good.result.twin).toMatchObject({ id: pair.twinId, mirrored: true })
        expect(surfaceNames(good.ourErrors, 'paired-vertex-count-mismatch')).toEqual([])
        expect(partitionSevere(severeDiff(good.base, good.run).added).geometric, good.run.err).toEqual([])
        expect(good.run.completed, good.run.err).toBe(true)

        const bad = attempt(file, 'delete-leave', del('leave'))
        expect(bad.run.completed).toBe(false)
        expect(severeDiff(bad.base, bad.run).added.some((s) => /Vertex size mismatch/.test(s))).toBe(true)
        expect(surfaceNames(bad.ourErrors, 'paired-vertex-count-mismatch')).toEqual(
          [pair.name, pair.twinName].map((n) => n.toUpperCase()).sort(),
        )
      },
      180_000,
    )
  }
})
