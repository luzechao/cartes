import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, EditHistory, type Model } from '../../src/model/index.js'
import {
  DragSession,
  intersectRayPlane,
  nearestEdge,
  planDrag,
  resolveModel,
  validateModel,
} from '../../src/geometry/index.js'

/**
 * The drag gestures, headless. The viewer only turns a pointer into a ray; everything that
 * decides what the drag *does* is here, so it is tested here.
 */

type P = [number, number, number]

function surface(name: string, type: string, zone: string, vs: P[], bc = 'Outdoors,'): string {
  return `BuildingSurface:Detailed,${name},${type},C,${zone},,${bc},NoSun,NoWind,0.5,${vs.length},
  ${vs.map((v) => v.join(',')).join(', ')};
`
}

/**
 * Two 4 x 4 x 3 boxes side by side along x, sharing the plane x = 4. Walls are wound
 * counter-clockwise seen from outside, per the header's GlobalGeometryRules.
 */
function box(zone: string, x0: number, opts: { eastTwin?: string; westTwin?: string } = {}): string {
  const x1 = x0 + 4
  return [
    surface(`${zone}-South`, 'Wall', zone, [[x0, 0, 3], [x0, 0, 0], [x1, 0, 0], [x1, 0, 3]]),
    surface(`${zone}-East`, 'Wall', zone, [[x1, 0, 3], [x1, 0, 0], [x1, 4, 0], [x1, 4, 3]],
      opts.eastTwin ? `Surface,${opts.eastTwin}` : 'Outdoors,'),
    surface(`${zone}-North`, 'Wall', zone, [[x1, 4, 3], [x1, 4, 0], [x0, 4, 0], [x0, 4, 3]]),
    surface(`${zone}-West`, 'Wall', zone, [[x0, 4, 3], [x0, 4, 0], [x0, 0, 0], [x0, 0, 3]],
      opts.westTwin ? `Surface,${opts.westTwin}` : 'Outdoors,'),
    surface(`${zone}-Floor`, 'Floor', zone, [[x0, 4, 0], [x1, 4, 0], [x1, 0, 0], [x0, 0, 0]], 'Ground,'),
    surface(`${zone}-Roof`, 'Roof', zone, [[x0, 0, 3], [x1, 0, 3], [x1, 4, 3], [x0, 4, 3]]),
  ].join('')
}

const SOURCE = `Version,26.1;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,World;
Zone,A;
Zone,B;
${box('A', 0, { eastTwin: 'B-West' })}${box('B', 4, { westTwin: 'A-East' })}`

function setup(text = SOURCE): { doc: IdfDocument; model: Model } {
  const doc = parseIdf(text)
  return { doc, model: buildModel(doc) }
}

function idOf(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

function namesOf(model: Model, refs: Array<{ surfaceId: string }>): string[] {
  return [...new Set(refs.map((r) => model.surfaces.get(r.surfaceId)!.name))].sort()
}

/** Index of a world vertex on a surface. */
function vertexAt(model: Model, name: string, p: P): number {
  const vs = resolveModel(model).get(idOf(model, name))!.worldVertices
  const i = vs.findIndex((v) => v.x === p[0] && v.y === p[1] && v.z === p[2])
  if (i === -1) throw new Error(`${name} has no vertex at ${p}`)
  return i
}

function errors(doc: IdfDocument): string[] {
  const m = buildModel(parseIdf(emitIdf(doc)))
  return validateModel(m, resolveModel(m))
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code)
}

describe('intersectRayPlane', () => {
  const floor = { normal: { x: 0, y: 0, z: 1 }, constant: 0 }
  it('meets a plane in front of the ray', () => {
    expect(intersectRayPlane({ origin: { x: 1, y: 2, z: 10 }, direction: { x: 0, y: 0, z: -2 } }, floor)).toEqual({ x: 1, y: 2, z: 0 })
  })
  it('refuses a plane behind the ray, and one it runs parallel to', () => {
    expect(intersectRayPlane({ origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: 1 } }, floor)).toBeUndefined()
    expect(intersectRayPlane({ origin: { x: 0, y: 0, z: 10 }, direction: { x: 1, y: 0, z: 0 } }, floor)).toBeUndefined()
  })
})

describe('planDrag — vertex', () => {
  it('takes the coplanar twin along, and leaves perpendicular neighbours alone', () => {
    const { model } = setup()
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-East'), vertexAt(model, 'A-East', [4, 0, 3]), 'vertex')!
    expect(start.refused).toBeUndefined()
    expect(namesOf(model, start.members)).toEqual(['A-East', 'B-West'])
  })

  it('keeps the drag in the surface plane, whatever the pointer asks for', () => {
    const { doc, model } = setup()
    const resolved = resolveModel(model)
    const id = idOf(model, 'A-East')
    const start = planDrag(model, resolved, id, vertexAt(model, 'A-East', [4, 4, 3]), 'vertex')!
    const session = new DragSession(doc, model, resolved, start)
    const u = session.update({ x: 5.7, y: 3.2, z: 2.5 })!
    expect(u.point.x).toBeCloseTo(4, 12)
    expect(u.point.y).toBeCloseTo(3.2, 12)
    expect(u.point.z).toBeCloseTo(2.5, 12)

    const after = resolveModel(buildModel(parseIdf(emitIdf(doc))))
    for (const name of ['A-East', 'B-West']) {
      const m = buildModel(parseIdf(emitIdf(doc)))
      expect(after.get(idOf(m, name))!.planarityError, name).toBeLessThan(1e-9)
    }
    // The pair moved together, so no pairing error — only the geometry the drag opened.
    expect(errors(doc)).not.toContain('paired-vertex-count-mismatch')
  })

  it('snaps to a coplanar vertex within tolerance', () => {
    const extra = surface('Panel', 'Wall', 'B', [[4, 6, 3], [4, 6, 0], [4, 7, 0], [4, 7, 3]])
    const { doc, model } = setup(SOURCE + extra)
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-East'), vertexAt(model, 'A-East', [4, 4, 3]), 'vertex')!
    const u = new DragSession(doc, model, resolved, start).update({ x: 4, y: 5.9, z: 2.95 })!
    expect(u.snap.kind).toBe('vertex')
    expect(u.point).toEqual({ x: 4, y: 6, z: 3 })
  })

  it('is absolute from the start, so returning to the origin restores the file byte for byte', () => {
    const { doc, model } = setup()
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-East'), vertexAt(model, 'A-East', [4, 4, 3]), 'vertex')!
    const session = new DragSession(doc, model, resolved, start, {
      vertex: false,
      edge: false,
      grid: false,
      gridSize: 0.1,
      tolerance: 0.25,
      planeTolerance: 1e-3,
    })
    for (let k = 0; k < 50; k++) session.update({ x: 4, y: 4 - Math.sin(k) * 0.7, z: 3 - Math.cos(k) * 0.3 })
    expect(emitIdf(doc)).not.toBe(SOURCE)
    session.update({ x: 4, y: 4, z: 3 })
    expect(emitIdf(doc)).toBe(SOURCE)
  })
})

describe('planDrag — corner', () => {
  it('moves the whole vertical edge, both zones, and keeps every surface planar', () => {
    const { doc, model } = setup()
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-Roof'), vertexAt(model, 'A-Roof', [4, 0, 3]), 'corner')!
    expect(start.refused).toBeUndefined()
    expect(namesOf(model, start.members)).toEqual(
      ['A-East', 'A-Floor', 'A-Roof', 'A-South', 'B-Floor', 'B-Roof', 'B-South', 'B-West'].sort(),
    )

    const u = new DragSession(doc, model, resolved, start).update({ x: 4.5, y: -0.4, z: 3 })!
    expect(u.point).toEqual({ x: 4.5, y: -0.4, z: 3 })

    const m = buildModel(parseIdf(emitIdf(doc)))
    for (const r of resolveModel(m).values()) expect(r.planarityError).toBeLessThan(1e-9)
    expect(errors(doc)).toEqual([])
  })

  it('refuses, and says why, when a wall at the corner carries a window', () => {
    const win = `FenestrationSurface:Detailed,Win,Window,G,A-South,,0.5,,1,4,
  1,0,2, 1,0,1, 3,0,1, 3,0,2;
`
    const { doc, model } = setup(SOURCE + win)
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-Roof'), vertexAt(model, 'A-Roof', [4, 0, 3]), 'corner')!
    expect(start.refused).toMatch(/A-South carries fenestration/)
    expect(new DragSession(doc, model, resolved, start).update({ x: 5, y: 0, z: 3 })).toBeUndefined()
    expect(emitIdf(doc)).toBe(SOURCE + win)
  })

  it('is one undo step for the whole gesture', () => {
    const { doc, model } = setup()
    const history = new EditHistory(doc)
    const resolved = resolveModel(model)
    const start = planDrag(model, resolved, idOf(model, 'A-Roof'), vertexAt(model, 'A-Roof', [0, 0, 3]), 'corner')!
    const session = new DragSession(doc, model, resolved, start)
    history.begin('Move corner')
    for (let k = 1; k <= 20; k++) session.update({ x: -k * 0.02, y: -k * 0.01, z: 3 })
    history.end()
    expect(history.undoCount).toBe(1)
    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
  })
})

describe('nearestEdge', () => {
  it('finds the edge to split, in the resolved order insertVertexWorld takes', () => {
    const { model } = setup()
    const r = resolveModel(model).get(idOf(model, 'A-South'))!
    const hit = nearestEdge(r, { x: 2, y: 0, z: 0.1 })!
    const a = r.worldVertices[hit.edgeIndex]!
    const b = r.worldVertices[(hit.edgeIndex + 1) % r.worldVertices.length]!
    expect([a.z, b.z]).toEqual([0, 0])
    expect(hit.point).toEqual({ x: 2, y: 0, z: 0 })
    expect(hit.distance).toBeCloseTo(0.1, 12)
  })
})
