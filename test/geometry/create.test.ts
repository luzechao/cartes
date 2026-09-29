import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import {
  buildModel,
  EditHistory,
  LATEST_IDD_VERSION,
  newModelSource,
  TEMPLATE_CONSTRUCTIONS as C,
  type Model,
  type Vec3,
} from '../../src/model/index.js'
import {
  applyMatchProposals,
  createBaseSurface,
  createSubSurface,
  extrudeZone,
  normalizeFootprint,
  openEdges,
  orderVertices,
  placeOpening,
  proposeMatches,
  resolveModel,
  suggestConstruction,
  surfaceExtent,
  toSourceOrder,
  validateModel,
} from '../../src/geometry/index.js'

/**
 * Creation tools on hand-sized geometry. The EnergyPlus gate (`eplus-create.test.ts`) says the
 * result is a model EnergyPlus accepts; these say which rule broke when it is not.
 */

const RULES = 'UpperLeftCorner,         !- Starting Vertex Position\n    Counterclockwise,        !- Vertex Entry Direction\n    Relative;'
const NORTH = '    0,                       !- North Axis {deg}'

function start(rules = 'UpperLeftCorner, Counterclockwise, Relative;', north = 0): { doc: IdfDocument; model: Model } {
  const src = newModelSource(LATEST_IDD_VERSION)
    .replace(RULES, rules)
    .replace(NORTH, `    ${north},                       !- North Axis {deg}`)
  const doc = parseIdf(src)
  return { doc, model: buildModel(doc) }
}

/** Reopen from text: what a user, or EnergyPlus, would see. */
function reopen(doc: IdfDocument): { doc: IdfDocument; model: Model } {
  const d = parseIdf(emitIdf(doc))
  return { doc: d, model: buildModel(d) }
}

function byName(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

const CONS = { wall: C.exteriorWall, floor: C.groundFloor, roof: C.roof }
const SQUARE = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 5 },
  { x: 0, y: 5 },
]
const round = (v: Vec3): [number, number, number] => [+v.x.toFixed(9) + 0, +v.y.toFixed(9) + 0, +v.z.toFixed(9) + 0]

describe('normalizeFootprint', () => {
  it('drops repeats and collinear points, and winds counter-clockwise', () => {
    const cw = [
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 0, y: 5 },
      { x: 3, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 0 },
    ]
    expect(normalizeFootprint(cw)).toEqual([
      { x: 6, y: 0 },
      { x: 6, y: 5 },
      { x: 0, y: 5 },
      { x: 0, y: 0 },
    ])
  })
})

describe('extrudeZone', () => {
  it('builds a closed, outward-facing box that validates clean', () => {
    const { doc, model } = start()
    const r = extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    expect(r.refused).toBeUndefined()
    expect(r.created).toHaveLength(1 + 4 + 2)

    const { model: m } = reopen(doc)
    const resolved = resolveModel(m)
    const n = (name: string): Vec3 => resolved.get(byName(m, name))!.normal
    expect(round(n('Z Floor'))).toEqual([0, 0, -1])
    expect(round(n('Z Roof'))).toEqual([0, 0, 1])
    expect(round(n('Z Wall 1'))).toEqual([0, -1, 0]) // south
    expect(round(n('Z Wall 2'))).toEqual([1, 0, 0]) // east
    expect(round(n('Z Wall 3'))).toEqual([0, 1, 0]) // north
    expect(round(n('Z Wall 4'))).toEqual([-1, 0, 0]) // west
    // Walls start upper-left seen from outside: south wall's first corner is (0, 0, 3).
    expect(round(resolved.get(byName(m, 'Z Wall 1'))!.worldVertices[0]!)).toEqual([0, 0, 3])

    expect(validateModel(m, resolved, m.doc).issues).toEqual([])
    const faces = [...m.surfaces.keys()].map((id) => resolved.get(id)!.worldVertices)
    expect(openEdges(faces)).toEqual([])
    expect(m.surfaces.get(byName(m, 'Z Floor'))!.kind === 'base' && (m.surfaces.get(byName(m, 'Z Floor')) as { outsideBoundaryCondition: string }).outsideBoundaryCondition).toBe('Ground')
  })

  it('extrudes a concave footprint into a closed zone', () => {
    const { doc, model } = start()
    const L = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
    ]
    extrudeZone(doc, model, { zoneName: 'L', footprint: L, height: 2.5, constructions: CONS })
    const { model: m } = reopen(doc)
    const resolved = resolveModel(m)
    expect(resolved.get(byName(m, 'L Floor'))!.area).toBeCloseTo(20, 9)
    expect(validateModel(m, resolved).issues).toEqual([])
  })

  /**
   * The strongest check on the write path: the same world geometry, written under every
   * combination of starting corner, entry direction, coordinate system and a rotated building,
   * must resolve back to exactly what was asked for.
   */
  it.each([
    ['UpperLeftCorner, Counterclockwise, Relative;', 0],
    ['LowerRightCorner, Clockwise, Relative;', 30],
    ['LowerLeftCorner, Clockwise, World;', 0],
    ['UpperRightCorner, Counterclockwise, Relative;', 137],
  ] as const)('writes in the file’s own conventions: %s north %d', (rules, north) => {
    const { doc, model } = start(rules, north)
    extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    const { model: m } = reopen(doc)
    const resolved = resolveModel(m)
    const south = resolved.get(byName(m, 'Z Wall 1'))!
    expect(south.worldVertices.map(round)).toEqual([
      [0, 0, 3],
      [0, 0, 0],
      [6, 0, 0],
      [6, 0, 3],
    ])
    expect(validateModel(m, resolved).issues).toEqual([])
  })

  it('refuses a footprint that crosses itself, a duplicate zone, a missing construction', () => {
    const { doc, model } = start()
    const bowtie = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]
    expect(extrudeZone(doc, model, { zoneName: 'X', footprint: bowtie, height: 3, constructions: CONS }).refused).toMatch(/crosses itself/)
    extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    expect(extrudeZone(doc, model, { zoneName: 'z', footprint: SQUARE, height: 3, constructions: CONS }).refused).toMatch(/already exists/)
    expect(
      extrudeZone(doc, model, { zoneName: 'Y', footprint: SQUARE, height: 3, constructions: { ...CONS, wall: 'Nope' } }).refused,
    ).toMatch(/wall construction 'Nope' does not exist/)
    expect(extrudeZone(doc, model, { zoneName: 'W', footprint: SQUARE.slice(0, 2), height: 3, constructions: CONS }).refused).toMatch(
      /at least three/,
    )
  })

  it('is one undo step', () => {
    const { doc, model } = start()
    const history = new EditHistory(doc)
    const before = emitIdf(doc)
    extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    expect(history.undoCount).toBe(1)
    history.undo()
    expect(emitIdf(doc)).toBe(before)
  })

  it('makes a raised floor Outdoors, ready for the matcher to pair with the roof below', () => {
    const { doc, model } = start()
    extrudeZone(doc, model, { zoneName: 'Low', footprint: SQUARE, height: 3, constructions: CONS })
    const { doc: d2, model: m2 } = reopen(doc)
    extrudeZone(d2, m2, { zoneName: 'High', footprint: SQUARE, baseZ: 3, height: 3, constructions: CONS })
    const { model: m } = reopen(d2)
    const floor = m.surfaces.get(byName(m, 'High Floor'))!
    expect(floor.kind === 'base' && floor.outsideBoundaryCondition).toBe('Outdoors')
  })
})

describe('toSourceOrder', () => {
  it('inverts the resolver’s permutation for every rule set', () => {
    const ring = [0, 1, 2, 3, 4].map((i) => ({ x: i, y: 0, z: 0 }))
    for (const rules of ['UpperLeftCorner, Clockwise, World;', 'LowerRightCorner, Counterclockwise, World;']) {
      const { model } = start(rules)
      const src = toSourceOrder(ring, model)
      // Feeding the source order back through the resolver's ordering reproduces the ring.
      expect(orderVertices(src, model.rules.startingVertexPosition, model.rules.vertexEntryDirection).vertices).toEqual(ring)
    }
  })
})

describe('windows and doors', () => {
  function box(): { doc: IdfDocument; model: Model } {
    const s = start()
    extrudeZone(s.doc, s.model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    return reopen(s.doc)
  }

  it('centres a window on a wall, facing out, and validates clean', () => {
    const { doc, model } = box()
    const wall = byName(model, 'Z Wall 1')
    const r = placeOpening(doc, model, wall, { construction: C.window, width: 2, height: 1.5, sill: 0.9 })
    expect(r.refused).toBeUndefined()
    const { model: m } = reopen(doc)
    const resolved = resolveModel(m)
    const win = resolved.get(byName(m, 'Z Wall 1 Window'))!
    expect(win.worldVertices.map(round)).toEqual([
      [2, 0, 2.4],
      [2, 0, 0.9],
      [4, 0, 0.9],
      [4, 0, 2.4],
    ])
    expect(validateModel(m, resolved).issues).toEqual([])
  })

  it('puts a door on the floor line', () => {
    const { doc, model } = box()
    const r = placeOpening(doc, model, byName(model, 'Z Wall 2'), {
      surfaceType: 'Door',
      construction: C.door,
      width: 0.9,
      height: 2.1,
      sill: 0,
      offset: 1,
    })
    expect(r.refused).toBeUndefined()
    const { model: m } = reopen(doc)
    expect(validateModel(m, resolveModel(m)).issues).toEqual([])
  })

  it('refuses an opening that does not fit, or overlaps another', () => {
    const { doc, model } = box()
    const wall = byName(model, 'Z Wall 1')
    expect(placeOpening(doc, model, wall, { construction: C.window, width: 2, height: 2.5, sill: 0.9 }).refused).toMatch(
      /extends outside Z Wall 1/,
    )
    placeOpening(doc, model, wall, { construction: C.window, width: 2, height: 1, sill: 1, offset: 1 })
    const { doc: d, model: m } = reopen(doc)
    expect(placeOpening(d, m, byName(m, 'Z Wall 1'), { construction: C.window, width: 2, height: 1, sill: 1, offset: 2 }).refused).toMatch(
      /overlaps Z Wall 1 Window/,
    )
  })

  it('checks containment by area, not corners — a window across the notch of an L-shaped wall', () => {
    const { doc, model } = start()
    extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: CONS })
    const r0 = reopen(doc)
    const zoneOk = createBaseSurface(r0.doc, r0.model, {
      name: 'Notched',
      surfaceType: 'Wall',
      construction: C.exteriorWall,
      zoneName: 'Z',
      boundary: 'Outdoors',
      // An L in the plane y = -1, facing -y: the upper-right quarter is missing.
      world: [
        { x: 0, y: -1, z: 4 },
        { x: 0, y: -1, z: 0 },
        { x: 4, y: -1, z: 0 },
        { x: 4, y: -1, z: 2 },
        { x: 2, y: -1, z: 2 },
        { x: 2, y: -1, z: 4 },
      ],
    })
    expect(zoneOk.refused).toBeUndefined()
    const { doc: d, model: m } = reopen(r0.doc)
    // A convex quad with all four corners inside the L, whose top edge cuts across the missing
    // quarter (at x = 2.5 it is at z = 2.43). Corner tests alone would accept it.
    const r = createSubSurface(d, m, {
      name: 'Across',
      surfaceType: 'Window',
      construction: C.window,
      baseId: byName(m, 'Notched'),
      world: [
        { x: 0.5, y: -1, z: 3.5 },
        { x: 0.5, y: -1, z: 0.5 },
        { x: 3.5, y: -1, z: 0.5 },
        { x: 3.5, y: -1, z: 1.9 },
      ],
    })
    expect(r.refused).toMatch(/extends outside Notched/)
  })

  it('enforces the four-vertex limit, coplanarity and facing', () => {
    const { doc, model } = box()
    const base = byName(model, 'Z Wall 1')
    const penta = [
      { x: 1, y: 0, z: 2 },
      { x: 1, y: 0, z: 1 },
      { x: 3, y: 0, z: 1 },
      { x: 3, y: 0, z: 2 },
      { x: 2, y: 0, z: 2.5 },
    ]
    expect(createSubSurface(doc, model, { name: 'P', surfaceType: 'Window', construction: C.window, baseId: base, world: penta }).refused).toMatch(
      /at most 4 vertices/,
    )
    const off = penta.slice(0, 4).map((p) => ({ ...p, y: 0.01 }))
    expect(createSubSurface(doc, model, { name: 'O', surfaceType: 'Window', construction: C.window, baseId: base, world: off }).refused).toMatch(
      /10\.0 mm off the plane/,
    )
    const reversed = penta.slice(0, 4).reverse()
    expect(
      createSubSurface(doc, model, { name: 'R', surfaceType: 'Window', construction: C.window, baseId: base, world: reversed }).refused,
    ).toMatch(/faces the other way/)
  })

  it('mirrors an opening onto an interzone twin, each naming the other', () => {
    const s = start()
    extrudeZone(s.doc, s.model, { zoneName: 'A', footprint: SQUARE, height: 3, constructions: CONS })
    let { doc, model } = reopen(s.doc)
    extrudeZone(doc, model, {
      zoneName: 'B',
      footprint: SQUARE.map((p) => ({ x: p.x + 6, y: p.y })),
      height: 3,
      constructions: CONS,
    })
    ;({ doc, model } = reopen(doc))
    applyMatchProposals(doc, model, proposeMatches(doc, model).proposals)
    ;({ doc, model } = reopen(doc))
    const r = placeOpening(doc, model, byName(model, 'A Wall 2'), { surfaceType: 'Door', construction: C.door, width: 0.9, height: 2.1, sill: 0 })
    expect(r.refused).toBeUndefined()
    expect(r.created).toHaveLength(2)
    const { model: m } = reopen(doc)
    const doors = [...m.surfaces.values()].filter((x) => x.kind === 'sub')
    expect(doors.map((d) => [d.name, d.kind === 'sub' && d.outsideBoundaryConditionObject]).sort()).toEqual([
      ['A Wall 2 Door B Wall 4', 'A Wall 2 Door'],
      ['A Wall 2 Door', 'A Wall 2 Door B Wall 4'],
    ])
    const resolved = resolveModel(m)
    expect(validateModel(m, resolved).issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('reports the space available', () => {
    const { model } = box()
    const r = resolveModel(model).get(byName(model, 'Z Wall 2'))!
    const e = surfaceExtent(r)
    expect(e.width).toBeCloseTo(5, 9)
    expect(e.height).toBeCloseTo(3, 9)
  })
})

describe('suggestConstruction', () => {
  it('prefers the file’s habit over the template’s names', () => {
    const { doc, model } = start()
    expect(suggestConstruction(doc, model, 'exterior-wall')).toBe(C.exteriorWall)
    extrudeZone(doc, model, { zoneName: 'Z', footprint: SQUARE, height: 3, constructions: { ...CONS, wall: C.interiorWall } })
    const { doc: d, model: m } = reopen(doc)
    expect(suggestConstruction(d, m, 'exterior-wall')).toBe(C.interiorWall)
  })
})
