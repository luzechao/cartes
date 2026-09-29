/**
 * Inverse coordinate resolution — the write half of Layer 3.
 *
 * `resolve.ts` turns vertices *as written* into world coordinates. This turns a world
 * coordinate back into the form the file wants, so that a vertex dragged in the viewport
 * lands in the document as `Relative` if the file is `Relative`, and rotated back out of
 * the building's north axis if one applies.
 *
 * Every function here is the exact algebraic inverse of its counterpart in `resolve.ts`.
 * That is not a nicety: if the two disagree by a rotation sign, every edit silently
 * corrupts the model in a way that still looks plausible in the viewport. The invariant
 * `unresolve(resolve(v)) === v` is asserted over the whole corpus, with rotations injected,
 * in `test/geometry/unresolve.test.ts`.
 */
import type { Model, Surface, Vec3, Zone } from '../model/index.js'
import { getSchema, vertexLayout } from '../model/index.js'
import { orderVertices, type TransformContext } from './resolve.js'

/**
 * Inverse of the `rotateXY` in `resolve.ts`.
 *
 * Forward is `[cos -sin; sin cos]`; a rotation matrix is orthogonal, so the inverse is the
 * transpose. No division, so no conditioning concerns at any angle.
 */
function unrotateXY(v: Vec3, r: { cos: number; sin: number }): Vec3 {
  return { x: v.x * r.cos + v.y * r.sin, y: -v.x * r.sin + v.y * r.cos, z: v.z }
}

/**
 * World coordinate → the value to write into the file, for one vertex.
 *
 * Mirrors the three branches of `resolveVertex` in the same order. Read the two side by
 * side; any change to one is a change to the other.
 */
export function unresolveVertex(
  world: Vec3,
  ctx: TransformContext,
  zone: Zone | undefined,
  isDetachedBuildingShading: boolean,
): Vec3 {
  if (ctx.coordinateSystem === 'World') {
    if (zone === undefined && !isDetachedBuildingShading) return world
    return unrotateXY(world, ctx.appendixGOnly)
  }

  if (zone !== undefined) {
    // Undo the building rotation, then the zone origin, then the zone's relative north —
    // the forward order reversed.
    const b = ctx.buildingRelNorth
    const xb = world.x * b.cos + world.y * b.sin
    const yb = -world.x * b.sin + world.y * b.cos

    const xo = xb - zone.origin.x
    const yo = yb - zone.origin.y

    const zr = ctx.zoneRotation.get(zone.id) ?? { cos: 1, sin: 0 }
    return {
      x: xo * zr.cos + yo * zr.sin,
      y: -xo * zr.sin + yo * zr.cos,
      z: world.z - zone.origin.z,
    }
  }

  if (isDetachedBuildingShading) return unrotateXY(world, ctx.buildingRelNorth)
  return world
}

/** The zone a surface resolves through, matching `resolve.ts`'s `zoneFor`. */
export function zoneForSurface(model: Model, surface: Surface): Zone | undefined {
  const zoneId = model.zoneOf.get(surface.id)
  return zoneId === undefined ? undefined : model.zones.get(zoneId)
}

/** Whether a surface takes the detached-building-shading transform branch. */
export function isDetachedBuildingShading(surface: Surface): boolean {
  return surface.kind === 'shading' && surface.shadingKind === 'building'
}

/** Convenience wrapper: unresolve a world point in the frame of a given surface. */
export function unresolveForSurface(
  model: Model,
  surface: Surface,
  ctx: TransformContext,
  world: Vec3,
): Vec3 {
  return unresolveVertex(world, ctx, zoneForSurface(model, surface), isDetachedBuildingShading(surface))
}

// ---------------------------------------------------------------------------
// Resolved index → document field index
// ---------------------------------------------------------------------------

export interface VertexFieldSlot {
  /** Index into `surface.vertices`, i.e. the vertex's position *as written*. */
  sourceIndex: number
  /** Field index of this vertex's X coordinate; Y and Z follow at +1 and +2. */
  fieldIndex: number
}

/**
 * Map a vertex's index in `ResolvedSurface.worldVertices` to the fields that hold it.
 *
 * Two separate remappings stack here, and skipping either puts the edit on the wrong
 * vertex:
 *
 *   1. `orderVertices` permutes the list for `Vertex Entry Direction` and
 *      `Starting Vertex Position`. `ResolvedSurface.sourceIndex` records that permutation.
 *   2. The IDD places vertex 1's X at `vertexLayout().beginIndex`, with a per-vertex
 *      `stride` — 3 for the detailed classes, but read from the schema rather than assumed.
 */
export function vertexFieldSlot(
  model: Model,
  surface: Surface,
  resolvedIndex: number,
): VertexFieldSlot | undefined {
  const schema = getSchema(surface.classKey, model.version)
  if (!schema) return undefined
  const layout = vertexLayout(schema)
  if (!layout) return undefined

  const ordered = orderVertices(
    surface.vertices,
    model.rules.startingVertexPosition,
    model.rules.vertexEntryDirection,
  )
  const sourceIndex = ordered.sourceIndex[resolvedIndex]
  if (sourceIndex === undefined) return undefined

  return { sourceIndex, fieldIndex: layout.beginIndex + sourceIndex * layout.stride }
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Coordinates below this magnitude are written as `0`.
 *
 * A rotation by 90 degrees puts 6.1e-17 where an exact zero belongs, because
 * `Math.cos(Math.PI / 2)` is not zero. Carrying that into the file is noise, not geometry:
 * 1e-9 m is a nanometre, some eleven orders of magnitude below the millimetre tolerances
 * the validator works in. Snapping is a deliberate, bounded lie and is documented as such.
 */
const ZERO_SNAP = 1e-9

/**
 * Format a coordinate for the file.
 *
 * `toPrecision(12)` discards the last few bits of a double, which is where floating-point
 * rounding noise accumulates — without it, moving a vertex and moving it back produces
 * `4.999999999999999` instead of `5`. Twelve significant digits is far more than any
 * building geometry carries and still round-trips through EnergyPlus's parser exactly.
 */
export function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) < ZERO_SNAP) return '0'
  const rounded = Number(value.toPrecision(12))
  if (Object.is(rounded, -0)) return '0'
  return String(rounded)
}
