import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  getSchema,
  LATEST_IDD_VERSION,
  newModelSource,
  planSurfaceDeletion,
  setFieldValue,
  TEMPLATE_CONSTRUCTIONS as C,
  vertexLayout,
  type Model,
} from '../../src/model/index.js'
import {
  applyMatchProposals,
  extrudeZone,
  placeOpening,
  proposeMatches,
  resolveModel,
  setVertexWorld,
  suggestInteriorConstructions,
  transformContext,
  validateModel,
} from '../../src/geometry/index.js'
import { runEnergyPlus, zoneInfo } from '../harness/energyplus.js'
import { available, canRun, exe, inPlaneMove, pickEditableSurface, readFixture } from '../harness/gate-fixtures.js'

/**
 * PHASE 8 GATE (docs/05-implementation-plan.md)
 *
 *   Create a two-zone model from scratch, export, and run in EnergyPlus with no severe errors.
 *
 * Measured more strictly than stated: no severe *and no warning at all*, and EnergyPlus's own
 * floor area and volume for every zone must equal the footprint area and area × height — an
 * independent check that every wall faces out, every floor down and every roof up, since a
 * zone that is not closed gets an approximate volume and a flipped surface gets a warning.
 *
 * The second half checks the two validator rules Phase 8 needed — upside-down floors and roofs,
 * and zone enclosure — against EnergyPlus on the mistakes a drawing tool makes possible.
 */

const RULES_LINE = 'UpperLeftCorner,         !- Starting Vertex Position\n    Counterclockwise,        !- Vertex Entry Direction\n    Relative;'
const NORTH_LINE = '    0,                       !- North Axis {deg}'
const CONS = { wall: C.exteriorWall, floor: C.groundFloor, roof: C.roof }

interface Built {
  doc: IdfDocument
  model: Model
}

function reopen(doc: IdfDocument): Built {
  const d = parseIdf(emitIdf(doc))
  return { doc: d, model: buildModel(d) }
}

function byName(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

function must<T extends { refused?: string }>(label: string, r: T): T {
  if (r.refused) throw new Error(`${label}: ${r.refused}`)
  return r
}

/**
 * Two zones side by side and a third on top of the first, with windows, an interzone door, and
 * every interzone pair wired by accepting the matcher's proposals — the authoring workflow.
 */
function scenario(rules = 'UpperLeftCorner, Counterclockwise, Relative;', north = 0, diagnostics = false): Built {
  let src = newModelSource(LATEST_IDD_VERSION)
    .replace(RULES_LINE, rules)
    .replace(NORTH_LINE, `    ${north},                       !- North Axis {deg}`)
  if (diagnostics) src += '\nOutput:Diagnostics,DisplayExtraWarnings;\n'
  let { doc, model } = reopen(parseIdf(src))
  const step = (): void => void ({ doc, model } = reopen(doc))
  const pairUp = (): void => {
    applyMatchProposals(
      doc,
      model,
      proposeMatches(doc, model, undefined, undefined, { interiorConstructions: suggestInteriorConstructions(doc, model) }).proposals,
    )
    step()
  }

  must('West', extrudeZone(doc, model, { zoneName: 'West', footprint: rect(0, 0, 6, 5), height: 3, constructions: CONS }))
  step()
  must('East', extrudeZone(doc, model, { zoneName: 'East', footprint: rect(6, 0, 4, 5), height: 3, constructions: CONS }))
  step()
  must('Upper', extrudeZone(doc, model, { zoneName: 'Upper', footprint: rect(0, 0, 6, 5), baseZ: 3, height: 3, constructions: CONS }))
  step()
  pairUp()
  for (const wall of ['West Wall 1', 'East Wall 1', 'Upper Wall 1']) {
    must(wall, placeOpening(doc, model, byName(model, wall), { construction: C.window, width: 2, height: 1.5, sill: 0.9 }))
    step()
  }
  must('door', placeOpening(doc, model, byName(model, 'West Wall 2'), { surfaceType: 'Door', construction: C.door, width: 0.9, height: 2.1, sill: 0 }))
  step()
  return { doc, model }
}

function rect(x: number, y: number, w: number, d: number): Array<{ x: number; y: number }> {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ]
}

const EXPECTED_ZONES = [
  { name: 'EAST', floorArea: 20, volume: 60 },
  { name: 'UPPER', floorArea: 30, volume: 90 },
  { name: 'WEST', floorArea: 30, volume: 90 },
]

/** Warnings EnergyPlus gives about the input itself rather than geometry, allowed by name. */
const BENIGN = [/^GetSurfaceData: World Coordinate System selected\. Any non-zero Building\/Zone North Axes/]

describe.skipIf(!canRun)('Phase 8 gate — a model authored from scratch runs in EnergyPlus', () => {
  it.each([
    ['UpperLeftCorner, Counterclockwise, Relative;', 0],
    ['LowerRightCorner, Clockwise, Relative;', 30],
    ['LowerLeftCorner, Clockwise, World;', 0],
    ['UpperRightCorner, Counterclockwise, World;', 45],
  ] as const)(
    'three zones, windows and an interzone door, written as %s north %d',
    (rules, north) => {
      const { doc, model } = scenario(rules, north)
      const text = emitIdf(doc)

      const resolved = resolveModel(model)
      expect(validateModel(model, resolved, doc).issues, 'our validator objects').toEqual([])
      // The matcher, run again, has nothing left to propose.
      expect(proposeMatches(doc, model).proposals).toEqual([])
      const interzone = [...model.surfaces.values()].filter(
        (s) => s.kind === 'base' && s.outsideBoundaryCondition === 'Surface',
      )
      expect(interzone.map((s) => s.name).sort()).toEqual(['East Wall 4', 'Upper Floor', 'West Roof', 'West Wall 2'])

      const run = runEnergyPlus(exe!, text, { workdir: `create/${rules.split(',')[0]}-${north}` })
      expect(run.severes, run.err).toEqual([])
      expect(run.fatals, run.err).toEqual([])
      expect(run.completed, run.err).toBe(true)
      expect(run.warnings.filter((w) => !BENIGN.some((b) => b.test(w))), 'EnergyPlus warned').toEqual([])
      expect(zoneInfo(run.eio).sort((a, b) => a.name.localeCompare(b.name))).toEqual(EXPECTED_ZONES)

      console.log(
        `from scratch (${rules} north ${north}): ${model.zones.size} zones, ${model.surfaces.size} surfaces, ` +
          `4 interzone surfaces paired by the matcher — E+ completes, 0 severe, 0 warnings, ` +
          zoneInfo(run.eio)
            .map((z) => `${z.name} ${z.floorArea} m² / ${z.volume} m³`)
            .join(', '),
      )
    },
    180_000,
  )
})

describe.skipIf(!canRun)('Phase 8 — the validator agrees with EnergyPlus on what drawing can break', () => {
  /** Reverse a surface's vertex list in place, as a mis-drawn outline would be. */
  function reverse(doc: IdfDocument, model: Model, name: string): void {
    const id = byName(model, name)
    const obj = doc.objects.get(id)!
    const layout = vertexLayout(getSchema(obj.classKey, model.version)!)!
    const n = model.surfaces.get(id)!.vertices.length
    const triples = Array.from({ length: n }, (_, i) =>
      obj.fields.slice(layout.beginIndex + i * 3, layout.beginIndex + i * 3 + 3).map((f) => f.value),
    ).reverse()
    triples.forEach((t, i) => t.forEach((v, k) => setFieldValue(doc, model, id, layout.beginIndex + i * 3 + k, v)))
  }

  /**
   * Ask EnergyPlus to name every open zone rather than count them. `Output:Diagnostics` is a
   * unique object, so a file that already has one gets the key added to it instead.
   */
  function withExtraWarnings(source: string): IdfDocument {
    const doc = parseIdf(source)
    const existing = doc.byClass.get('output:diagnostics')?.[0]
    if (existing === undefined) return parseIdf(source + '\nOutput:Diagnostics,DisplayExtraWarnings;\n')
    const obj = doc.objects.get(existing)!
    if (!obj.fields.some((f) => f.value.toLowerCase() === 'displayextrawarnings')) {
      obj.fields.push({ value: 'DisplayExtraWarnings' })
      obj.dirty = true
    }
    return parseIdf(emitIdf(doc))
  }

  function upsideDown(err: string): string[] {
    return [...err.matchAll(/(?:Floor|Roof\/Ceiling) is upside down! .*?Surface="([^"]+)"/g)].map((m) => m[1]!).sort()
  }
  function notEnclosed(err: string): string[] {
    return [...err.matchAll(/The Zone="([^"]+)" is not fully enclosed/g)].map((m) => m[1]!).sort()
  }
  function ours(doc: IdfDocument, code: 'surface-inverted-normal' | 'zone-not-enclosed'): string[] {
    const m = buildModel(parseIdf(emitIdf(doc)))
    return validateModel(m, resolveModel(m), m.doc)
      .issues.filter((i) => i.code === code)
      .map((i) => (code === 'zone-not-enclosed' ? i.relatedObjectName! : i.objectName).toUpperCase())
      .sort()
  }

  it('a floor and a roof drawn upside down: both named, by both', () => {
    const { doc, model } = scenario(undefined, undefined, true)
    reverse(doc, model, 'East Floor')
    reverse(doc, model, 'Upper Roof')
    const run = runEnergyPlus(exe!, emitIdf(doc), { workdir: 'create/upside-down' })
    expect(upsideDown(run.err)).toEqual(['EAST FLOOR', 'UPPER ROOF'])
    expect(ours(doc, 'surface-inverted-normal')).toEqual(upsideDown(run.err))
  }, 180_000)

  it('a zone left without its roof: named, by both', () => {
    const { doc, model } = scenario(undefined, undefined, true)
    const roof = byName(model, 'East Roof')
    applySurfaceDeletion(doc, model, planSurfaceDeletion(doc, model, buildReferenceIndex(doc, model.version), roof)!)
    const run = runEnergyPlus(exe!, emitIdf(doc), { workdir: 'create/no-roof' })
    expect(notEnclosed(run.err)).toEqual(['EAST'])
    expect(ours(doc, 'zone-not-enclosed')).toEqual(notEnclosed(run.err))
  }, 180_000)

  /**
   * The Phase 6 measurement, now from our side: moving one vertex of a shipped file opens its
   * zone, and EnergyPlus says so. Before Phase 8 the validator did not.
   */
  for (const file of available) {
    it(`${file}: a single-vertex move opens the same zone for both`, () => {
      const doc = withExtraWarnings(readFixture(file))
      const model = buildModel(doc)
      const baseline = ours(doc, 'zone-not-enclosed')
      expect(baseline, `${file} baseline`).toEqual([])

      const surface = pickEditableSurface(model)!
      const r = resolveModel(model).get(surface.id)!
      setVertexWorld(doc, model, surface.id, 0, inPlaneMove(r.worldVertices[0]!, r.worldVertices[1]!)!, transformContext(model))
      const run = runEnergyPlus(exe!, emitIdf(doc), { workdir: `create/agree/${file}` })
      expect(ours(doc, 'zone-not-enclosed'), `${file}: moved ${surface.name}`).toEqual(notEnclosed(run.err))
      console.log(`${file}: moved one vertex of ${surface.name} — E+ and we both report ${JSON.stringify(notEnclosed(run.err))} open`)
    }, 180_000)
  }
})
