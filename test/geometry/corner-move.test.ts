import { describe, expect, it } from 'vitest'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel, type Model } from '../../src/model/index.js'
import {
  edgeIsSubdivided,
  moveVertices,
  planCornerMove,
  resolveModel,
  verticesAt,
  verticesOnVerticalEdge,
} from '../../src/geometry/index.js'

/**
 * Unit tests for the corner-move primitives.
 *
 * The EnergyPlus gate in `eplus-gate.test.ts` and `eplus-refs.test.ts` measures these against
 * a real simulation on real files, which is the evidence that they are *correct*. These tests
 * do the complementary job: they pin the behaviour on geometry small enough to reason about
 * by hand, so a regression says which rule broke rather than which fixture stopped running.
 *
 * Every fixture here is written inline for that reason. A corpus file would exercise the same
 * code with none of the legibility.
 */

function surface(name: string, zone: string, vertices: Array<[number, number, number]>): string {
  return `
  BuildingSurface:Detailed,
    ${name},
    Wall,
    C1,
    ${zone},
    ,
    Outdoors,
    ,
    SunExposed,
    WindExposed,
    0.5,
    ${vertices.length},
${vertices.map((v) => `    ${v[0]},${v[1]},${v[2]}`).join(',\n')};
`
}

const HEADER = `
  Version,26.1;
  Building,Test,0,,,,,,;
  GlobalGeometryRules,UpperLeftCorner,Counterclockwise,World;
  Zone,Z1,0,0,0,0,,,,,,,Yes;
  Zone,Z2,0,0,0,0,,,,,,,Yes;
`

function load(body: string): { model: Model; resolved: ReturnType<typeof resolveModel> } {
  const model = buildModel(parseIdf(HEADER + body))
  return { model, resolved: resolveModel(model) }
}

/** Ids keyed by surface name, so assertions can read in names rather than object ids. */
function idsByName(model: Model): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, s] of model.surfaces) out.set(s.name, id)
  return out
}

/**
 * A 4 m x 4 m x 3 m box: four walls sharing vertical edges at each plan corner.
 *
 * Each wall is written upper-left, counter-clockwise looking from outside, which is what
 * `GlobalGeometryRules` above declares.
 */
const BOX = [
  surface('South', 'Z1', [
    [0, 0, 3],
    [0, 0, 0],
    [4, 0, 0],
    [4, 0, 3],
  ]),
  surface('East', 'Z1', [
    [4, 0, 3],
    [4, 0, 0],
    [4, 4, 0],
    [4, 4, 3],
  ]),
  surface('North', 'Z1', [
    [4, 4, 3],
    [4, 4, 0],
    [0, 4, 0],
    [0, 4, 3],
  ]),
  surface('West', 'Z1', [
    [0, 4, 3],
    [0, 4, 0],
    [0, 0, 0],
    [0, 0, 3],
  ]),
].join('')

describe('verticesAt', () => {
  it('finds every vertex at a point, across surfaces', () => {
    const { model, resolved } = load(BOX)
    const ids = idsByName(model)

    // The top of the vertical edge at (4, 0) belongs to both South and East.
    const hits = verticesAt(resolved, { x: 4, y: 0, z: 3 })
    expect(new Set(hits.map((h) => h.surfaceId))).toEqual(
      new Set([ids.get('South'), ids.get('East')]),
    )
    expect(hits).toHaveLength(2)
  })

  it('is a three-dimensional test, not a plan-view one', () => {
    const { resolved } = load(BOX)
    // Same plan position, different height: the bottom of the same edge, not the top.
    const top = verticesAt(resolved, { x: 4, y: 0, z: 3 })
    const bottom = verticesAt(resolved, { x: 4, y: 0, z: 0 })
    expect(bottom).toHaveLength(2)
    expect(top).not.toEqual(bottom)
  })

  it('respects the tolerance it is given', () => {
    const { resolved } = load(BOX)
    const near = { x: 4.0005, y: 0, z: 3 }
    expect(verticesAt(resolved, near)).toHaveLength(0)
    expect(verticesAt(resolved, near, 1e-3)).toHaveLength(2)
  })
})

describe('verticesOnVerticalEdge', () => {
  it('collects the whole vertical edge, top and bottom, on every incident surface', () => {
    const { model, resolved } = load(BOX)
    const ids = idsByName(model)

    const refs = verticesOnVerticalEdge(resolved, 4, 0)
    // Two surfaces x two heights.
    expect(refs).toHaveLength(4)
    expect(new Set(refs.map((r) => r.surfaceId))).toEqual(
      new Set([ids.get('South'), ids.get('East')]),
    )

    const zs = refs.map((r) => resolved.get(r.surfaceId)!.worldVertices[r.resolvedIndex]!.z).sort()
    expect(zs).toEqual([0, 0, 3, 3])
  })

  it('returns nothing where no vertex stands', () => {
    const { resolved } = load(BOX)
    expect(verticesOnVerticalEdge(resolved, 2, 2)).toEqual([])
  })
})

describe('edgeIsSubdivided', () => {
  /**
   * The case this predicate was written for, reduced to its essentials.
   *
   * `PurchAirWithDaylighting.idf` has a zone whose south face is two collinear walls meeting
   * at an intermediate point, while the floor spans the whole run as a single edge. Moving the
   * far corner bends the floor edge, and the intermediate vertex stops lying on it — so
   * EnergyPlus reports the zone as no longer enclosed. Vertex coincidence alone is therefore
   * not a sufficient precondition for a corner move.
   */
  const SPLIT_FACE = [
    // A single wall spanning x = 0..4 at y = 0.
    surface('Long', 'Z1', [
      [0, 0, 3],
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
    ]),
    // Two walls covering the same run, meeting at x = 2.
    surface('HalfA', 'Z2', [
      [0, 0, 3],
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 3],
    ]),
    surface('HalfB', 'Z2', [
      [2, 0, 3],
      [2, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
    ]),
  ].join('')

  it('sees a vertex sitting part-way along an edge', () => {
    const { resolved } = load(SPLIT_FACE)
    expect(edgeIsSubdivided({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, resolved)).toBe(true)
  })

  it('does not count the endpoints as subdivisions', () => {
    const { resolved } = load(BOX)
    // The box's south wall base edge has vertices only at its ends.
    expect(edgeIsSubdivided({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, resolved)).toBe(false)
  })

  it('ignores a vertex that is near the line but not on it', () => {
    const { resolved } = load(
      BOX +
        surface('Offset', 'Z2', [
          [2, 0.5, 3],
          [2, 0.5, 0],
          [3, 0.5, 0],
          [3, 0.5, 3],
        ]),
    )
    expect(edgeIsSubdivided({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, resolved)).toBe(false)
  })

  it('treats a zero-length edge as unsubdivided rather than dividing by zero', () => {
    const { resolved } = load(BOX)
    const p = { x: 0, y: 0, z: 0 }
    expect(edgeIsSubdivided(p, p, resolved)).toBe(false)
  })
})

describe('planCornerMove', () => {
  it('gathers the vertical edge at a plan corner', () => {
    const { model, resolved } = load(BOX)
    const plan = planCornerMove(model, resolved, 4, 0)

    expect(plan.coherent).toBe(true)
    expect(plan.members).toHaveLength(4)
    expect(plan.blocked).toEqual([])
    expect(plan.subdividedEdges).toEqual([])
    expect(plan.splitPairs).toEqual([])
  })

  it('reports no members, and is not coherent, away from any corner', () => {
    const { model, resolved } = load(BOX)
    const plan = planCornerMove(model, resolved, 2, 2)
    expect(plan.members).toEqual([])
    expect(plan.coherent).toBe(false)
  })

  it('refuses a corner whose incident edge another surface subdivides', () => {
    const { model, resolved } = load(
      BOX +
        // A wall meeting the south face half way along, adding a vertex at (2, 0) that the
        // south wall's own base edge does not have.
        surface('Spur', 'Z2', [
          [2, 0, 3],
          [2, 0, 0],
          [2, 2, 0],
          [2, 2, 3],
        ]),
    )

    const plan = planCornerMove(model, resolved, 4, 0)
    expect(plan.coherent).toBe(false)
    expect(plan.subdividedEdges.length).toBeGreaterThan(0)
  })

  it('blocks a wall carrying a window, because moving it could orphan the window', () => {
    const { model, resolved } = load(
      BOX +
        `
  FenestrationSurface:Detailed,
    W1,
    Window,
    C1,
    South,
    ,
    ,
    ,
    ,
    ,
    4,
    1,0,2, 1,0,1, 3,0,1, 3,0,2;
`,
    )

    const plan = planCornerMove(model, resolved, 4, 0)
    expect(plan.coherent).toBe(false)
    expect(plan.blocked.map((b) => model.surfaces.get(b.surfaceId)!.name)).toContain('South')
    // The window itself is excluded too, with its own reason.
    expect(plan.blocked.map((b) => b.reason).join(' ')).toMatch(/sub-surface|fenestration/i)
  })

  it('moves a fenestrated wall when asked to', () => {
    const { model, resolved } = load(
      BOX +
        `
  FenestrationSurface:Detailed,
    W1,
    Window,
    C1,
    South,
    ,
    ,
    ,
    ,
    ,
    4,
    1,0,2, 1,0,1, 3,0,1, 3,0,2;
`,
    )

    const plan = planCornerMove(model, resolved, 4, 0, { excludeFenestrated: false })
    expect(plan.blocked.map((b) => model.surfaces.get(b.surfaceId)!.name)).not.toContain('South')
    // The sub-surface is still excluded; it is moved by moving its base surface.
    expect(plan.members.map((m) => model.surfaces.get(m.surfaceId)!.name)).not.toContain('W1')
  })
})

describe('planCornerMove — interzone twins', () => {
  /**
   * Two zones sharing a partition, drawn at their inside faces so the two named faces are 30
   * mm apart. `Plenum.idf` is built this way, and EnergyPlus accepts it because it matches
   * interzone surfaces by name and area rather than by coordinates.
   */
  const OFFSET_PAIR = `
  BuildingSurface:Detailed,
    PartA, Wall, C1, Z1, , Surface, PartB, NoSun, NoWind, 0.5, 4,
    0,0,3, 0,0,0, 0,4,0, 0,4,3;
  BuildingSurface:Detailed,
    PartB, Wall, C1, Z2, , Surface, PartA, NoSun, NoWind, 0.5, 4,
    0.03,4,3, 0.03,4,0, 0.03,0,0, 0.03,0,3;
`

  const COINCIDENT_PAIR = `
  BuildingSurface:Detailed,
    PartA, Wall, C1, Z1, , Surface, PartB, NoSun, NoWind, 0.5, 4,
    0,0,3, 0,0,0, 0,4,0, 0,4,3;
  BuildingSurface:Detailed,
    PartB, Wall, C1, Z2, , Surface, PartA, NoSun, NoWind, 0.5, 4,
    0,4,3, 0,4,0, 0,0,0, 0,0,3;
`

  it('says nothing about a pair whose sides are coincident, because both move', () => {
    const { model, resolved } = load(COINCIDENT_PAIR)
    const plan = planCornerMove(model, resolved, 0, 0)

    const moved = new Set(plan.members.map((m) => model.surfaces.get(m.surfaceId)!.name))
    expect(moved).toEqual(new Set(['PartA', 'PartB']))
    expect(plan.splitPairs).toEqual([])
  })

  it('reports a pair whose sides are offset, because only one would move', () => {
    const { model, resolved } = load(OFFSET_PAIR)
    const plan = planCornerMove(model, resolved, 0, 0)

    const moved = new Set(plan.members.map((m) => model.surfaces.get(m.surfaceId)!.name))
    expect(moved).toEqual(new Set(['PartA']))
    expect(plan.splitPairs).toEqual([
      expect.objectContaining({ surfaceName: 'PartA', twinName: 'PartB' }),
    ])
  })

  it('reports the split without refusing the move', () => {
    // Measured against EnergyPlus: a split of this kind draws no complaint at 50 mm or 250 mm,
    // and only crosses the interzone area tolerance around 1 m. Refusing outright would be a
    // rule of our own invention, and it left `Plenum.idf` with no movable corner at all.
    const { model, resolved } = load(OFFSET_PAIR)
    const plan = planCornerMove(model, resolved, 0, 0)
    expect(plan.splitPairs).toHaveLength(1)
    expect(plan.coherent).toBe(true)
  })

  it('does not report a surface that names itself as its own twin', () => {
    // The corpus uses this to model a slab between identical zones. There is no second side
    // to keep in step.
    const { model, resolved } = load(`
  BuildingSurface:Detailed,
    Slab, Floor, C1, Z1, , Surface, Slab, NoSun, NoWind, 0.5, 4,
    0,0,0, 0,4,0, 4,4,0, 4,0,0;
`)
    expect(planCornerMove(model, resolved, 0, 0).splitPairs).toEqual([])
  })
})

describe('moveVertices', () => {
  it('translates every member by the same delta', () => {
    const source = HEADER + BOX
    const doc = parseIdf(source)
    const model = buildModel(doc)
    const resolved = resolveModel(model)

    const plan = planCornerMove(model, resolved, 4, 0)
    const result = moveVertices(doc, model, resolved, plan.members, { x: 0.5, y: 0.25, z: 0 })

    expect(result.changed).toBe(true)
    // Two surfaces touch this corner, so exactly two objects become dirty.
    expect(new Set(result.dirtied)).toHaveLength(2)

    const after = resolveModel(buildModel(doc))
    expect(verticesAt(after, { x: 4.5, y: 0.25, z: 3 })).toHaveLength(2)
    expect(verticesAt(after, { x: 4, y: 0, z: 3 })).toHaveLength(0)
  })

  it('measures every member against the same starting geometry', () => {
    // The members are read from `resolved`, not re-read as each write lands. If they were
    // re-read, a surface appearing twice in the member list would move twice.
    const doc = parseIdf(HEADER + BOX)
    const model = buildModel(doc)
    const resolved = resolveModel(model)

    const plan = planCornerMove(model, resolved, 4, 0)
    const duplicated = [...plan.members, ...plan.members]
    moveVertices(doc, model, resolved, duplicated, { x: 1, y: 0, z: 0 })

    const after = resolveModel(buildModel(doc))
    expect(verticesAt(after, { x: 5, y: 0, z: 3 })).toHaveLength(2)
    expect(verticesAt(after, { x: 6, y: 0, z: 3 })).toHaveLength(0)
  })

  it('reports no change for a zero delta, and leaves the text alone', () => {
    const doc = parseIdf(HEADER + BOX)
    const model = buildModel(doc)
    const resolved = resolveModel(model)

    const plan = planCornerMove(model, resolved, 4, 0)
    const result = moveVertices(doc, model, resolved, plan.members, { x: 0, y: 0, z: 0 })

    expect(result.changed).toBe(false)
    expect(result.dirtied).toEqual([])
    expect([...doc.objects.values()].some((o) => o.dirty)).toBe(false)
  })

  it('ignores a member naming a surface that is not there', () => {
    const doc = parseIdf(HEADER + BOX)
    const model = buildModel(doc)
    const resolved = resolveModel(model)

    const result = moveVertices(
      doc,
      model,
      resolved,
      [{ surfaceId: 'no-such-surface', resolvedIndex: 0 }],
      { x: 1, y: 1, z: 1 },
    )
    expect(result.changed).toBe(false)
  })
})
