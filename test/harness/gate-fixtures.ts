/**
 * Shared setup for the Phase 6 EnergyPlus gate.
 *
 * Fixture selection is measured, not assumed. All twelve geometry-rich candidates were run
 * against EnergyPlus 26.1 first; these seven complete cleanly with zero severe errors. The
 * rest do fail, but for reasons that have nothing to do with us and would make the gate's
 * baseline permanently red:
 *
 *   - `AtticRoof_RadiantBarriers`, `ZoneCoupledKivaBasement` — Kiva `Foundation` boundary
 *     conditions require a weather file, which design-day-only runs do not supply.
 *   - `SurfacePropTest_SurfLWR` — reads an external `LocalEnvData.csv` that ships beside it
 *     in the EnergyPlus source tree and is not part of our fixture set.
 *   - `_1Zone_Heavy_AdiabaticX2` — carries no `Site:Location`, so there is no design day to
 *     run at all.
 *
 * Those are worth revisiting if the gate ever needs weather-file support; they are recorded
 * here rather than silently dropped.
 *
 * One further exclusion is ours, not EnergyPlus's: `4ZoneWithShading_Simple_1.idf` runs
 * perfectly but is built entirely from the Tier-3 rectangular classes (`Wall:Exterior`,
 * `Window`, `Shading:Site`), which describe geometry by azimuth, tilt, length and height
 * rather than by vertices. There is no vertex in that file to move. A test in
 * `eplus-gate.test.ts` pins that down, so the exclusion stays honest if the tier-3 work of
 * Phase 9 ever lands.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model, type Surface } from '../../src/model/index.js'
import { resolveModel } from '../../src/geometry/index.js'
import { resolveEnergyPlus } from './energyplus.js'

export const FIXTURES = join(import.meta.dirname, '../fixtures/testfiles')

export const GATE_FILES = [
  '1ZoneUncontrolled.idf',
  '1ZoneUncontrolled_DD2009.idf',
  'Plenum.idf',
  '5ZoneAirCooled.idf',
  '5ZoneAirCooled_AirBoundaries.idf',
  'PurchAirWithDaylighting.idf',
  'PassiveTrombeWall.idf',
]

/** Runs cleanly, but holds no editable vertex. See the header comment. */
export const TIER3_ONLY_FILE = '4ZoneWithShading_Simple_1.idf'

export const exe = resolveEnergyPlus()
export const available = GATE_FILES.filter((f) => existsSync(join(FIXTURES, f)))
export const canRun = exe !== undefined && available.length > 0

export function readFixture(file: string): string {
  return readFileSync(join(FIXTURES, file), 'utf8')
}

export function modelOf(file: string): Model {
  return buildModel(parseIdf(readFixture(file)))
}

/**
 * Severe errors a geometry change can legitimately trigger without the file being wrong.
 *
 * `CheckWarmupConvergence` fires when a zone's temperatures have not settled within the
 * allowed warmup days. It is a property of thermal mass, conditioning and the tolerances set
 * in the `Building` object — not of whether the geometry we wrote is valid. `PassiveTrombeWall`
 * is a passive-solar model with heavy mass and no mechanical conditioning, and sits close
 * enough to its tolerance that a 50 mm change of geometry flips it. EnergyPlus still completes.
 *
 * These are reported in the test output rather than hidden, but they do not fail the gate.
 * Every other severe does.
 */
export const NON_GEOMETRIC_SEVERE: RegExp[] = [/^CheckWarmupConvergence:/]

export function partitionSevere(added: readonly string[]): {
  geometric: string[]
  thermal: string[]
} {
  const thermal = added.filter((m) => NON_GEOMETRIC_SEVERE.some((p) => p.test(m)))
  const geometric = added.filter((m) => !NON_GEOMETRIC_SEVERE.some((p) => p.test(m)))
  return { geometric, thermal }
}

/**
 * An interzone pair: two surfaces each naming the other as its outside boundary.
 *
 * Only pairs whose partner actually exists in the file are returned, so a fixture that already
 * carries a dangling boundary reference cannot be mistaken for a pair.
 */
export interface InterzonePair {
  id: string
  name: string
  twinId: string
  twinName: string
  /** True when either side carries a window, door or attached shading. */
  fenestrated: boolean
  /**
   * Largest distance from a vertex of one side to the nearest vertex of the other.
   *
   * Zero for the usual case of two surfaces drawn on the same plane. Non-zero when the model
   * draws each zone at its inside face and leaves the partition thickness between them, which
   * EnergyPlus accepts because it matches interzone surfaces by name and area rather than by
   * coordinates. `Plenum.idf` does this, with a 36 mm offset.
   */
  gap: number
}

function carriesFenestration(s: Surface): boolean {
  return s.kind === 'base' && (s.subSurfaces.length > 0 || s.attachedShading.length > 0)
}

export function interzonePairs(model: Model): InterzonePair[] {
  const byName = new Map<string, string>()
  for (const [id, s] of model.surfaces) byName.set(s.name.trim().toLowerCase(), id)
  const resolved = resolveModel(model)

  const out: InterzonePair[] = []
  for (const s of model.surfaces.values()) {
    if (s.kind !== 'base') continue
    if (s.outsideBoundaryCondition.trim().toLowerCase() !== 'surface') continue
    const twinId = byName.get(s.outsideBoundaryConditionObject.trim().toLowerCase())
    // A surface naming *itself* is how the corpus models a slab between identical zones; it
    // has no separate twin to keep in step, so it is not a pair for our purposes.
    if (twinId === undefined || twinId === s.id) continue
    const twin = model.surfaces.get(twinId)!

    const a = resolved.get(s.id)?.worldVertices ?? []
    const b = resolved.get(twinId)?.worldVertices ?? []
    let gap = 0
    for (const va of a) {
      let nearest = Infinity
      for (const vb of b) {
        nearest = Math.min(nearest, Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z))
      }
      if (Number.isFinite(nearest)) gap = Math.max(gap, nearest)
    }

    out.push({
      id: s.id,
      name: s.name,
      twinId,
      twinName: twin.name,
      fenestrated: carriesFenestration(s) || carriesFenestration(twin),
      gap,
    })
  }
  return out
}

/** Gate fixtures that actually contain an interzone pair. */
export const PAIRED_FILES = available.filter((f) => interzonePairs(modelOf(f)).length > 0)

/**
 * Slide a point a short way along the edge towards another.
 *
 * Moving strictly within the surface's own plane means planarity is preserved exactly, so a
 * new "surface is non-planar" severe would be our bug and not an artefact of the test. 50 mm
 * is far above the validator's millimetre tolerances — a no-op edit would make the gate
 * vacuous — and far below the size of any surface in the corpus, so the polygon stays simple.
 */
export const MOVE_DISTANCE = 0.05

export interface Point3 {
  x: number
  y: number
  z: number
}

export function inPlaneMove(from: Point3, toward: Point3): Point3 | undefined {
  const edge = { x: toward.x - from.x, y: toward.y - from.y, z: toward.z - from.z }
  const len = Math.hypot(edge.x, edge.y, edge.z)
  if (!(len > MOVE_DISTANCE * 10)) return undefined
  const k = MOVE_DISTANCE / len
  return { x: from.x + edge.x * k, y: from.y + edge.y * k, z: from.z + edge.z * k }
}

/** Distinct plan-view positions of every vertex in the model, in resolution order. */
export function cornerCandidates(
  resolved: ReturnType<typeof resolveModel>,
): Array<{ x: number; y: number }> {
  const seen = new Set<string>()
  const out: Array<{ x: number; y: number }> = []
  for (const r of resolved.values()) {
    for (const v of r.worldVertices) {
      const key = `${Math.round(v.x / 1e-6)},${Math.round(v.y / 1e-6)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ x: v.x, y: v.y })
    }
  }
  return out
}

/**
 * Pick a surface that can be edited without breaking a constraint the edit path does not yet
 * maintain.
 *
 * This block moves a *single* vertex, deliberately the crudest edit available, so it avoids
 * surfaces whose neighbours would have to move with it. Detached shading is ideal — it has no
 * adjacency at all. Failing that, an `Outdoors` surface carrying neither windows nor attached
 * shading has no dependant geometry either.
 *
 * Referential integrity is not dodged by this choice; it is tested separately and explicitly
 * in `eplus-refs.test.ts`, which edits and deletes surfaces chosen precisely *because* they
 * are paired.
 */
export function pickEditableSurface(model: Model): Surface | undefined {
  const surfaces = [...model.surfaces.values()]

  const detachedShading = surfaces.find(
    (s) => s.kind === 'shading' && s.shadingKind !== 'zone' && s.vertices.length >= 3,
  )
  if (detachedShading) return detachedShading

  return surfaces.find(
    (s) =>
      s.kind === 'base' &&
      s.outsideBoundaryCondition.toLowerCase() === 'outdoors' &&
      s.outsideBoundaryConditionObject.trim() === '' &&
      s.subSurfaces.length === 0 &&
      s.attachedShading.length === 0 &&
      s.vertices.length >= 3,
  )
}
