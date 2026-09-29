import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel } from '../../src/model/index.js'
import type { Vec3 } from '../../src/model/index.js'
import {
  DEFAULT_SNAP_SETTINGS,
  SnapIndex,
  buildSnapIndex,
  closestPointOnSegment,
  distanceToPlane,
  planeOfSurface,
  projectOntoPlane,
  resolveModel,
  resolveSurface,
  setVertexWorld,
  snapPoint,
  transformContext,
} from '../../src/geometry/index.js'

const FIXTURES = join(import.meta.dirname, '../fixtures/testfiles')
const SAMPLE = join(FIXTURES, '1ZoneUncontrolled.idf')
const haveFixtures = existsSync(SAMPLE)

function idx(targets: Array<{ point: Vec3; surfaceId: string; vertexIndex: number }>): SnapIndex {
  const index = new SnapIndex(1)
  for (const t of targets) index.addVertex(t)
  return index
}

describe('snap — geometry helpers', () => {
  it('clamps the closest point to the ends of a segment', () => {
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 10, y: 0, z: 0 }
    expect(closestPointOnSegment({ x: 5, y: 3, z: 0 }, a, b)).toEqual({ x: 5, y: 0, z: 0 })
    expect(closestPointOnSegment({ x: -7, y: 1, z: 0 }, a, b)).toEqual(a)
    expect(closestPointOnSegment({ x: 42, y: 1, z: 0 }, a, b)).toEqual(b)
    // A zero-length segment must not divide by zero.
    expect(closestPointOnSegment({ x: 1, y: 1, z: 1 }, a, a)).toEqual(a)
  })

  it('measures and removes distance to a plane', () => {
    const plane = { normal: { x: 0, y: 0, z: 1 }, constant: 3 }
    expect(distanceToPlane({ x: 9, y: -2, z: 3.25 }, plane)).toBeCloseTo(0.25, 12)
    expect(projectOntoPlane({ x: 9, y: -2, z: 3.25 }, plane)).toEqual({ x: 9, y: -2, z: 3 })
  })
})

describe('snap — priority and tolerance', () => {
  const settings = { ...DEFAULT_SNAP_SETTINGS, grid: true, gridSize: 1, tolerance: 0.5 }

  it('prefers a vertex to an edge even when the edge is marginally closer', () => {
    const index = new SnapIndex(1)
    index.addVertex({ point: { x: 1, y: 0, z: 0 }, surfaceId: 'S1', vertexIndex: 2 })
    // An edge passing closer to the cursor than that vertex.
    index.addEdge({
      a: { x: -10, y: 0.05, z: 0 },
      b: { x: 10, y: 0.05, z: 0 },
      surfaceId: 'S2',
      edgeIndex: 0,
    })

    const result = snapPoint({ x: 0.9, y: 0, z: 0 }, index, settings)
    expect(result.kind).toBe('vertex')
    expect(result.surfaceId).toBe('S1')
    expect(result.vertexIndex).toBe(2)
    expect(result.point).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('falls through vertex to edge to grid to none', () => {
    const empty = new SnapIndex(1)
    // Nothing to snap to but the grid.
    const onGrid = snapPoint({ x: 2.1, y: 2.9, z: 0.05 }, empty, settings)
    expect(onGrid.kind).toBe('grid')
    expect(onGrid.point).toEqual({ x: 2, y: 3, z: 0 })

    // Too far from any grid line to engage.
    const tight = { ...settings, tolerance: 0.01 }
    expect(snapPoint({ x: 2.4, y: 0, z: 0 }, empty, tight).kind).toBe('none')

    // Edge only.
    const edges = new SnapIndex(1)
    edges.addEdge({
      a: { x: 0, y: 0, z: 0 },
      b: { x: 0, y: 10, z: 0 },
      surfaceId: 'E',
      edgeIndex: 3,
    })
    const onEdge = snapPoint({ x: 0.2, y: 4, z: 0 }, edges, { ...settings, grid: false })
    expect(onEdge.kind).toBe('edge')
    expect(onEdge.edgeIndex).toBe(3)
    expect(onEdge.point.x).toBeCloseTo(0, 12)
  })

  it('does not engage a disabled snap kind', () => {
    const index = idx([{ point: { x: 1, y: 0, z: 0 }, surfaceId: 'S', vertexIndex: 0 }])
    const off = snapPoint({ x: 0.95, y: 0, z: 0 }, index, {
      ...settings,
      vertex: false,
      edge: false,
      grid: false,
    })
    expect(off.kind).toBe('none')
    expect(off.point).toEqual({ x: 0.95, y: 0, z: 0 })
  })
})

describe('snap — the plane constraint', () => {
  const plane = { normal: { x: 0, y: 1, z: 0 }, constant: 0 }

  it('rejects candidates that would break the dragged surface planarity', () => {
    const index = idx([
      // In the plane: a legitimate shared corner.
      { point: { x: 1, y: 0, z: 0 }, surfaceId: 'InPlane', vertexIndex: 0 },
      // Half a metre off it: a corner of some other wall entirely.
      { point: { x: 0.95, y: 0.5, z: 0 }, surfaceId: 'OffPlane', vertexIndex: 0 },
    ])

    const result = snapPoint({ x: 0.96, y: 0.02, z: 0 }, index, DEFAULT_SNAP_SETTINGS, plane)
    expect(result.kind).toBe('vertex')
    expect(result.surfaceId).toBe('InPlane')
  })

  it('returns a point exactly on the plane even when nothing snaps', () => {
    const empty = new SnapIndex(1)
    const result = snapPoint({ x: 3, y: 0.004, z: 2 }, empty, DEFAULT_SNAP_SETTINGS, plane)
    expect(result.kind).toBe('none')
    expect(distanceToPlane(result.point, plane)).toBeLessThan(1e-15)
  })
})

describe.skipIf(!haveFixtures)('snap — against real geometry', () => {
  it('builds an index that excludes the surface being dragged', () => {
    const model = buildModel(parseIdf(readFileSync(SAMPLE, 'utf8')))
    const resolved = resolveModel(model)
    const dragged = [...resolved.keys()][0]!

    const index = buildSnapIndex(resolved, { exclude: dragged })
    for (const v of resolved.get(dragged)!.worldVertices) {
      const found = index.verticesNear(v, 1e-6)
      expect(found.every((t) => t.surfaceId !== dragged)).toBe(true)
    }
  })

  it('snaps a dragged vertex back onto the corner it shares with its neighbours', () => {
    const doc = parseIdf(readFileSync(SAMPLE, 'utf8'))
    const source = readFileSync(SAMPLE, 'utf8')
    const model = buildModel(doc)
    const ctx = transformContext(model)
    const resolved = resolveModel(model)

    const surfaceId = [...resolved.keys()].find(
      (id) => model.surfaces.get(id)?.kind === 'base',
    )!
    const surface = model.surfaces.get(surfaceId)!
    const original = resolved.get(surfaceId)!.worldVertices[0]!

    // Every other surface is a snap candidate; the dragged one is not, or it would snap to
    // the position it is being dragged away from.
    const index = buildSnapIndex(resolved, { exclude: surfaceId })
    const plane = planeOfSurface(resolved.get(surfaceId)!)

    // A sloppy drag, 30 mm off the corner in each axis.
    const sloppy = { x: original.x + 0.03, y: original.y + 0.03, z: original.z + 0.03 }
    const snapped = snapPoint(sloppy, index, DEFAULT_SNAP_SETTINGS, plane)

    expect(snapped.kind, 'no neighbouring vertex was within tolerance').toBe('vertex')
    expect(Math.hypot(
      snapped.point.x - original.x,
      snapped.point.y - original.y,
      snapped.point.z - original.z,
    )).toBeLessThan(1e-9)

    // Writing the snapped position back is a no-op, so the file is untouched. That is the
    // whole point: a snapped drag onto a shared corner does not perturb the model.
    const result = setVertexWorld(doc, model, surfaceId, 0, snapped.point, ctx)
    expect(result.changed).toBe(false)
    expect(emitIdf(doc)).toBe(source)

    // And the unsnapped drag really would have moved it, or the above proves nothing.
    const moved = setVertexWorld(doc, model, surfaceId, 0, sloppy, ctx)
    expect(moved.changed).toBe(true)
    const after = resolveSurface(model, surface, ctx)
    expect(after.worldVertices[0]!.z).toBeCloseTo(sloppy.z, 9)
  })
})
