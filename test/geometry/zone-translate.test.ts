import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, getSchema, readNumber, type Model } from '../../src/model/index.js'
import {
  applyZoneTranslation,
  planZoneTranslation,
  resolveModel,
  resolveVertex,
  transformContext,
} from '../../src/geometry/index.js'

/**
 * Whole-zone translate on inline fixtures, with rotations everywhere a rotation can apply —
 * building north axis, zone relative north, Appendix G — because with the corpus's own zero
 * angles a transposed sine is invisible (see `unresolve.test.ts`).
 *
 * The measure of correctness is always the same: re-parse the emitted text, resolve it, and
 * require every point in the zone to have moved by exactly the requested world delta, and
 * every point outside it not to have moved at all.
 */

const DELTA = { x: 3.25, y: -1.5, z: 0.75 }

function load(text: string): { doc: IdfDocument; model: Model } {
  const doc = parseIdf(text)
  return { doc, model: buildModel(doc) }
}

function zoneId(model: Model, name: string): string {
  for (const [id, z] of model.zones) if (z.name === name) return id
  throw new Error(`no zone ${name}`)
}

/** World vertices by surface name, from a fresh parse. */
function worldByName(text: string): Map<string, Array<{ x: number; y: number; z: number }>> {
  const m = buildModel(parseIdf(text))
  const r = resolveModel(m)
  const out = new Map<string, Array<{ x: number; y: number; z: number }>>()
  for (const [id, s] of m.surfaces) out.set(s.name, r.get(id)!.worldVertices)
  return out
}

/** World position of every daylighting reference point, resolved the way E+ resolves them. */
function referencePoints(text: string): Map<string, { x: number; y: number; z: number }> {
  const m = buildModel(parseIdf(text))
  const ctx = { ...transformContext(m), coordinateSystem: m.rules.daylightingReferencePointCoordinateSystem }
  const out = new Map<string, { x: number; y: number; z: number }>()
  for (const id of m.doc.byClass.get('daylighting:referencepoint') ?? []) {
    const obj = m.doc.objects.get(id)!
    const schema = getSchema(obj.classKey, m.version)!
    const zoneName = obj.fields[1]!.value
    const zone = [...m.zones.values()].find((z) => z.name === zoneName)
    const p = {
      x: readNumber(obj, schema, 'X-Coordinate of Reference Point')!,
      y: readNumber(obj, schema, 'Y-Coordinate of Reference Point')!,
      z: readNumber(obj, schema, 'Z-Coordinate of Reference Point')!,
    }
    out.set(obj.fields[0]!.value, resolveVertex(p, ctx, zone, false))
  }
  return out
}

function expectMovedBy(
  before: ReadonlyArray<{ x: number; y: number; z: number }>,
  after: ReadonlyArray<{ x: number; y: number; z: number }>,
  by: { x: number; y: number; z: number },
  label: string,
): void {
  expect(after.length, label).toBe(before.length)
  before.forEach((b, i) => {
    const a = after[i]!
    expect(Math.abs(a.x - (b.x + by.x)), `${label} vertex ${i} x`).toBeLessThan(1e-9)
    expect(Math.abs(a.y - (b.y + by.y)), `${label} vertex ${i} y`).toBeLessThan(1e-9)
    expect(Math.abs(a.z - (b.z + by.z)), `${label} vertex ${i} z`).toBeLessThan(1e-9)
  })
}

const ZERO = { x: 0, y: 0, z: 0 }

function body(opts: { twin?: boolean } = {}): string {
  return `
BuildingSurface:Detailed,A-Floor,Floor,C,A,,Ground,,NoSun,NoWind,0,4,
  0,4,0, 4,4,0, 4,0,0, 0,0,0;
BuildingSurface:Detailed,A-East,Wall,C,A,,${opts.twin ? 'Surface,B-West' : 'Outdoors,'},SunExposed,WindExposed,0.5,4,
  4,0,3, 4,0,0, 4,4,0, 4,4,3;
FenestrationSurface:Detailed,A-Win,Window,G,A-Floor,,0.5,,1,4,
  1,3,0, 3,3,0, 3,1,0, 1,1,0;
Shading:Zone:Detailed,A-Fin,A-East,,4,
  4,0,3, 5,0,3, 5,0,0, 4,0,0;
BuildingSurface:Detailed,B-West,Wall,C,B,,${opts.twin ? 'Surface,A-East' : 'Outdoors,'},SunExposed,WindExposed,0.5,4,
  0,4,3, 0,4,0, 0,0,0, 0,0,3;
Shading:Site:Detailed,Tree,,4,
  9,9,5, 9,10,5, 9,10,0, 9,9,0;
Daylighting:ReferencePoint,A-Ref,A,2,2,0.8;
Daylighting:ReferencePoint,B-Ref,B,1,1,0.8;
`
}

function header(system: 'Relative' | 'World', daylighting: 'Relative' | 'World' = system): string {
  return `Version,26.1;
Building,Test,30;
Compliance:Building,17;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,${system},${daylighting};
Zone,A,20,10,5,1;
Zone,B,-35,14,0,0;
`
}

describe('translateZone — geometry', () => {
  it.each(['Relative', 'World'] as const)(
    '%s: moves every surface in the zone by exactly the delta and nothing else',
    (system) => {
      const source = header(system) + body()
      const { doc, model } = load(source)
      const plan = planZoneTranslation(doc, model, zoneId(model, 'A'), DELTA)!
      const result = applyZoneTranslation(doc, model, plan)
      expect(result.changed).toBe(true)

      const before = worldByName(source)
      const after = worldByName(emitIdf(doc))
      for (const name of ['A-Floor', 'A-East', 'A-Win', 'A-Fin']) {
        expectMovedBy(before.get(name)!, after.get(name)!, DELTA, name)
      }
      for (const name of ['B-West', 'Tree']) expectMovedBy(before.get(name)!, after.get(name)!, ZERO, name)

      // And the live Model agrees with the fresh parse, without a rebuild.
      const live = resolveModel(model)
      for (const [id, s] of model.surfaces) {
        expectMovedBy(after.get(s.name)!, live.get(id)!.worldVertices, ZERO, `live ${s.name}`)
      }
    },
  )

  it('Relative: the whole zone is one field-level edit on the Zone object', () => {
    const source = header('Relative') + body()
    const { doc, model } = load(source)
    const a = zoneId(model, 'A')
    const plan = planZoneTranslation(doc, model, a, DELTA)!
    expect(plan.surfaces).toEqual([])
    expect(plan.origin).toBeDefined()

    const result = applyZoneTranslation(doc, model, plan)
    expect(result.dirtied).toEqual([a])
    const changed = emitIdf(doc).split('\n').filter((l, i) => l !== source.split('\n')[i])
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatch(/^Zone,A,20,/)
  })

  it('World: surfaces are rewritten, the origin is left alone', () => {
    const { doc, model } = load(header('World') + body())
    const plan = planZoneTranslation(doc, model, zoneId(model, 'A'), DELTA)!
    expect(plan.origin).toBeUndefined()
    expect(plan.surfaces).toHaveLength(4)
  })

  it.each([
    ['Relative', 'Relative'],
    ['Relative', 'World'],
    ['World', 'Relative'],
    ['World', 'World'],
  ] as const)('surfaces %s, daylighting %s: reference points travel with their zone', (s, d) => {
    const source = header(s, d) + body()
    const { doc, model } = load(source)
    const plan = planZoneTranslation(doc, model, zoneId(model, 'A'), DELTA)!
    // The origin moves iff something in the zone rides on it.
    expect(plan.origin !== undefined).toBe(s === 'Relative' || d === 'Relative')
    applyZoneTranslation(doc, model, plan)

    const before = referencePoints(source)
    const after = referencePoints(emitIdf(doc))
    expectMovedBy([before.get('A-Ref')!], [after.get('A-Ref')!], DELTA, 'A-Ref')
    expectMovedBy([before.get('B-Ref')!], [after.get('B-Ref')!], ZERO, 'B-Ref')

    // Mixed systems are where a half-right implementation shows: surfaces must still land too.
    const sb = worldByName(source)
    const sa = worldByName(emitIdf(doc))
    expectMovedBy(sb.get('A-East')!, sa.get('A-East')!, DELTA, 'A-East')
  })

  it('shifts an illuminance map in its own frame', () => {
    const source =
      header('World') + body() + 'Output:IlluminanceMap,Map,A,0.8,0.5,3.5,4,0.5,3.5,4;\n'
    const { doc, model } = load(source)
    applyZoneTranslation(doc, model, planZoneTranslation(doc, model, zoneId(model, 'A'), DELTA)!)
    const map = emitIdf(doc).split('\n').find((l) => l.startsWith('Output:IlluminanceMap'))!
    // World with a 17-degree Appendix G rotation: the grid moves by the de-rotated delta.
    const c = Math.cos((17 * Math.PI) / 180)
    const sn = Math.sin((17 * Math.PI) / 180)
    const dx = DELTA.x * c - DELTA.y * sn
    const dy = DELTA.x * sn + DELTA.y * c
    const f = map.replace(';', '').split(',').slice(4).map(Number)
    expect(f[0]).toBeCloseTo(0.5 + dx, 9)
    expect(f[1]).toBeCloseTo(3.5 + dx, 9)
    expect(f[2]).toBe(4)
    expect(f[3]).toBeCloseTo(0.5 + dy, 9)
    expect(f[4]).toBeCloseTo(3.5 + dy, 9)
    expect(Number(map.split(',')[3])).toBeCloseTo(0.8 + DELTA.z, 9)
  })

  it('reports interzone pairs the move pulls apart', () => {
    const { doc, model } = load(header('Relative') + body({ twin: true }))
    const plan = planZoneTranslation(doc, model, zoneId(model, 'A'), DELTA)!
    expect(plan.splitPairs.map((p) => [p.surfaceName, p.twinName])).toEqual([['A-East', 'B-West']])
  })

  it('names World-positioned rectangular surfaces it cannot yet carry, rather than dropping them', () => {
    const tier3 = 'Wall:Exterior,A-Rect,C,A,,0,90,0,0,0,4,3;\n'
    const world = load(header('World').replace('World,World;', 'World,World,World;') + body() + tier3)
    const plan = planZoneTranslation(world.doc, world.model, zoneId(world.model, 'A'), DELTA)!
    expect(plan.leftBehind.map((l) => l.name)).toEqual(['A-Rect'])

    // Relative rectangular surfaces ride on the origin, so nothing is left behind.
    const rel = load(header('World').replace('World,World;', 'World,World,Relative;') + body() + tier3)
    const relPlan = planZoneTranslation(rel.doc, rel.model, zoneId(rel.model, 'A'), DELTA)!
    expect(relPlan.leftBehind).toEqual([])
    expect(relPlan.origin).toBeDefined()
  })
})
