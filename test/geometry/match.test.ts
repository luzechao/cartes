import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, EditHistory, type Model } from '../../src/model/index.js'
import {
  applyMatchProposals,
  findCoincidentPairs,
  proposeMatches,
  resolveModel,
  validateModel,
} from '../../src/geometry/index.js'

/**
 * Surface auto-matching on geometry small enough to check by hand. The corpus gate
 * (`match-gate.test.ts`) and the EnergyPlus gate (`eplus-match.test.ts`) say whether it is
 * right on real files; these say which rule broke when it is not.
 */

type P = [number, number, number]

function wall(name: string, zone: string, vs: P[], bc = 'Outdoors,', exposure = 'SunExposed,WindExposed'): string {
  return `BuildingSurface:Detailed,${name},Wall,C,${zone},,${bc},${exposure},0.5,${vs.length},
  ${vs.map((v) => v.join(',')).join(', ')};
`
}

function window(name: string, base: string, vs: P[], obc = ''): string {
  return `FenestrationSurface:Detailed,${name},Window,G,${base},${obc},0.5,,1,${vs.length},
  ${vs.map((v) => v.join(',')).join(', ')};
`
}

const HEADER = `Version,26.1;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,World;
Zone,A;
Zone,B;
Zone,C;
`

/** The plane x = 4, seen from zone A (normal +x) and from zone B (normal −x). */
const A_SIDE: P[] = [[4, 0, 3], [4, 0, 0], [4, 4, 0], [4, 4, 3]]
const B_SIDE: P[] = [[4, 4, 3], [4, 4, 0], [4, 0, 0], [4, 0, 3]]

function load(body: string): { doc: IdfDocument; model: Model } {
  const doc = parseIdf(HEADER + body)
  return { doc, model: buildModel(doc) }
}

function nameOf(model: Model, id: string): string {
  return model.surfaces.get(id)!.name
}

function idOf(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

describe('findCoincidentPairs', () => {
  it('finds two opposed faces of one partition, fully overlapping', () => {
    const { model } = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', B_SIDE))
    const [p, ...rest] = findCoincidentPairs(model)
    expect(rest).toEqual([])
    expect([nameOf(model, p!.a), nameOf(model, p!.b), p!.kind]).toEqual(['A-E', 'B-W', 'full'])
    expect(p!.overlapArea).toBeCloseTo(12, 9)
  })

  it('ignores faces that point the same way, or sit a centimetre apart', () => {
    const same = load(wall('A-E', 'A', A_SIDE) + wall('B-E', 'B', A_SIDE))
    expect(findCoincidentPairs(same.model)).toEqual([])
    const apart = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', B_SIDE.map(([x, y, z]) => [x + 0.01, y, z] as P)))
    expect(findCoincidentPairs(apart.model)).toEqual([])
  })

  it('measures a partial overlap as a share of each face', () => {
    const half: P[] = [[4, 2, 3], [4, 2, 0], [4, 0, 0], [4, 0, 3]]
    const { model } = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', half))
    const [p] = findCoincidentPairs(model)
    expect(p!.kind).toBe('partial')
    expect(p!.fractionA).toBeCloseTo(0.5, 9)
    expect(p!.fractionB).toBeCloseTo(1, 9)
  })

  it('handles a concave face — an L-shaped floor against a ceiling under one of its arms', () => {
    // Floor of B at z = 3 facing down (the L), ceiling of A at z = 3 facing up (one arm).
    const floorL = `BuildingSurface:Detailed,B-Floor,Floor,C,B,,Outdoors,,NoSun,NoWind,0,6,
  0,0,3, 0,6,3, 2,6,3, 2,2,3, 6,2,3, 6,0,3;
`
    const ceiling = `BuildingSurface:Detailed,A-Ceil,Roof,C,A,,Outdoors,,SunExposed,WindExposed,0,4,
  4,0,3, 6,0,3, 6,2,3, 4,2,3;
`
    const { model } = load(floorL + ceiling)
    const [p] = findCoincidentPairs(model)
    expect(p!.kind).toBe('partial')
    expect(p!.overlapArea).toBeCloseTo(4, 9)
  })
})

describe('proposeMatches', () => {
  it('proposes pairing two exposed faces pressed together, with exposure turned off', () => {
    const { doc, model } = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', B_SIDE))
    const r = proposeMatches(doc, model)
    expect(r.proposals).toHaveLength(1)
    const p = r.proposals[0]!
    expect(p.kind).toBe('pair-exposed')
    expect(p.changes.map((c) => [c.objectName, c.fieldName, c.from, c.to])).toEqual([
      ['A-E', 'Outside Boundary Condition', 'Outdoors', 'Surface'],
      ['A-E', 'Outside Boundary Condition Object', '', 'B-W'],
      ['A-E', 'Sun Exposure', 'SunExposed', 'NoSun'],
      ['A-E', 'Wind Exposure', 'WindExposed', 'NoWind'],
      ['B-W', 'Outside Boundary Condition', 'Outdoors', 'Surface'],
      ['B-W', 'Outside Boundary Condition Object', '', 'A-E'],
      ['B-W', 'Sun Exposure', 'SunExposed', 'NoSun'],
      ['B-W', 'Wind Exposure', 'WindExposed', 'NoWind'],
    ])
  })

  it('completes a pair declared on one side only', () => {
    const { doc, model } = load(
      wall('A-E', 'A', A_SIDE, 'Surface,B-W', 'NoSun,NoWind') + wall('B-W', 'B', B_SIDE),
    )
    const [p, ...rest] = proposeMatches(doc, model).proposals
    expect(rest).toEqual([])
    expect(p!.kind).toBe('complete-pair')
    expect(p!.changes.every((c) => c.objectName === 'B-W')).toBe(true)
  })

  it('repairs a reference to a surface that does not exist', () => {
    const { doc, model } = load(
      wall('A-E', 'A', A_SIDE, 'Surface,Typo', 'NoSun,NoWind') + wall('B-W', 'B', B_SIDE),
    )
    const [p] = proposeMatches(doc, model).proposals
    expect(p!.kind).toBe('repair-reference')
    expect(p!.reason).toMatch(/A-E names 'Typo', which does not exist/)
    expect(p!.changes.find((c) => c.objectName === 'A-E')!.to).toBe('B-W')
  })

  it('never proposes against a consistent declared pair, even one geometry cannot confirm', () => {
    // A declared pair drawn 6 m apart — as ChangeoverBypassVAV.idf does — plus a free exposed
    // face coincident with one side of it.
    const far = B_SIDE.map(([x, y, z]) => [x + 6, y, z] as P)
    const { doc, model } = load(
      wall('A-E', 'A', A_SIDE, 'Surface,B-W', 'NoSun,NoWind') +
        wall('B-W', 'B', far, 'Surface,A-E', 'NoSun,NoWind') +
        wall('C-W', 'C', B_SIDE),
    )
    const r = proposeMatches(doc, model)
    expect(r.proposals).toEqual([])
    expect(r.unconfirmed.map((n) => [nameOf(model, n.a), nameOf(model, n.b!)])).toEqual([['A-E', 'B-W']])
    expect(r.blocked.map((n) => n.reason)).toEqual(['A-E is already paired with B-W'])
  })

  it('leaves a deliberate boundary alone', () => {
    const { doc, model } = load(wall('A-E', 'A', A_SIDE, 'Adiabatic,', 'NoSun,NoWind') + wall('B-W', 'B', B_SIDE))
    const r = proposeMatches(doc, model)
    expect(r.proposals).toEqual([])
    expect(r.intentional[0]!.reason).toMatch(/A-E is Adiabatic/)
  })

  it('refuses to guess when a face coincides with two others', () => {
    const { doc, model } = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', B_SIDE) + wall('C-W', 'C', B_SIDE))
    const r = proposeMatches(doc, model)
    expect(r.proposals).toEqual([])
    expect(r.blocked.every((b) => /coincides with 2 surfaces/.test(b.reason))).toBe(true)
  })

  it('does not pair two faces of the same zone', () => {
    const { doc, model } = load(wall('A-E', 'A', A_SIDE) + wall('A-W', 'A', B_SIDE))
    const r = proposeMatches(doc, model)
    expect(r.proposals).toEqual([])
    expect(r.blocked[0]!.reason).toMatch(/both in zone A/)
  })

  it('flags a partial overlap between exposed faces as needing a split, and proposes nothing', () => {
    const half: P[] = [[4, 2, 3], [4, 2, 0], [4, 0, 0], [4, 0, 3]]
    const { doc, model } = load(wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', half))
    const r = proposeMatches(doc, model)
    expect(r.proposals).toEqual([])
    expect(r.partial).toHaveLength(1)
  })

  describe('windows', () => {
    const winA: P[] = [[4, 1, 2], [4, 1, 1], [4, 3, 1], [4, 3, 2]]
    const winB: P[] = [[4, 3, 2], [4, 3, 1], [4, 1, 1], [4, 1, 2]]

    it('pairs the windows along with their walls', () => {
      const { doc, model } = load(
        wall('A-E', 'A', A_SIDE) + window('A-Win', 'A-E', winA) + wall('B-W', 'B', B_SIDE) + window('B-Win', 'B-W', winB),
      )
      const [p] = proposeMatches(doc, model).proposals
      const windows = p!.changes.filter((c) => c.objectName.endsWith('Win'))
      expect(windows.map((c) => [c.objectName, c.fieldName, c.to])).toEqual([
        ['A-Win', 'Outside Boundary Condition Object', 'B-Win'],
        ['B-Win', 'Outside Boundary Condition Object', 'A-Win'],
      ])
    })

    it('blocks the pair when the windows do not line up', () => {
      const moved = winB.map(([x, y, z]) => [x, y + 0.5, z] as P)
      const { doc, model } = load(
        wall('A-E', 'A', A_SIDE) + window('A-Win', 'A-E', winA) + wall('B-W', 'B', B_SIDE) + window('B-Win', 'B-W', moved),
      )
      const r = proposeMatches(doc, model)
      expect(r.proposals).toEqual([])
      expect(r.blocked[0]!.reason).toMatch(/A-Win has no single opposite number/)
    })
  })
})

describe('applyMatchProposals', () => {
  it('applies as one undo step, leaves the model valid, and is idempotent', () => {
    const body = wall('A-E', 'A', A_SIDE) + wall('B-W', 'B', B_SIDE)
    const { doc, model } = load(body)
    const history = new EditHistory(doc)
    const r = proposeMatches(doc, model)
    const dirtied = applyMatchProposals(doc, model, r.proposals)
    expect(dirtied.sort()).toEqual([idOf(model, 'A-E'), idOf(model, 'B-W')].sort())
    expect(history.undoCount).toBe(1)

    const again = buildModel(parseIdf(emitIdf(doc)))
    const after = proposeMatches(again.doc, again)
    expect(after.proposals).toEqual([])
    expect(after.confirmed).toHaveLength(1)
    const errors = validateModel(again, resolveModel(again)).issues.filter((i) => i.severity === 'error')
    expect(errors).toEqual([])

    history.undo()
    expect(emitIdf(doc)).toBe(HEADER + body)
  })
})
