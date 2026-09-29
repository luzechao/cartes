/**
 * Coordinate resolution — Layer 3 of docs/04-architecture.md.
 *
 * Turns vertices *as written* into world coordinates, matching what EnergyPlus computes in
 * `SurfaceGeometry.cc::GetVertices`. Deliberately bug-compatible: where EnergyPlus does
 * something surprising, so do we, because the point of this editor is to show what the
 * simulation will see.
 *
 * Nothing here writes back to the document. Resolution is derived state; the file's
 * `Relative` vertices stay relative.
 *
 * Derived from EnergyPlus source code; see NOTICE for its copyright notice and license.
 */
import type {
  CoordinateSystem,
  GeometryRules,
  Model,
  StartingVertexPosition,
  Surface,
  Vec3,
  VertexEntryDirection,
  Zone,
} from '../model/index.js'
import { triangulate } from './triangulate.js'

export interface ResolvedSurface {
  id: string
  /** World coordinates, after reordering and transform. */
  worldVertices: Vec3[]
  /**
   * For each entry of `worldVertices`, its index in the surface's as-written vertex list.
   * Reordering is a permutation, so dragging resolved vertex `i` writes back to source
   * vertex `sourceIndex[i]` — without this, an edit on a Clockwise file lands on the wrong
   * three fields.
   */
  sourceIndex: number[]
  /** Unit outward normal by Newell's method. Zero vector for a degenerate polygon. */
  normal: Vec3
  /** Greatest distance of any vertex from the best-fit plane, in metres. */
  planarityError: number
  /**
   * earcut indices into `worldVertices`, three per triangle, each wound counter-clockwise
   * about `normal`. Empty for a degenerate surface — see `triangulate.ts`.
   */
  triangles: Uint32Array
  /** Projected area, in m². */
  area: number
  centroid: Vec3
}

// ---------------------------------------------------------------------------
// Vertex ordering
// ---------------------------------------------------------------------------

/** EnergyPlus's corner numbering, from `FlCorners` in `SurfaceGeometry.cc`. */
const CORNER_NUMBER: Record<StartingVertexPosition, number> = {
  UpperLeftCorner: 1,
  LowerLeftCorner: 2,
  LowerRightCorner: 3,
  UpperRightCorner: 4,
}

/**
 * How many single-place left rotations `GetVertices` performs for a given corner.
 *
 * The source is a while loop that walks the corner index forward until it reaches
 * `UpperLeftCorner`, each pass swapping its way around the ring — which works out to exactly
 * one left rotation per pass, whatever the starting index. Hence the closed form:
 *
 *     shifts = (nSides - corner + 1) mod nSides
 *
 * The loop also breaks early when `nSides < 4` and the corner is `UpperRightCorner`. That
 * guard is kept below for fidelity, but it changes nothing at three sides — the formula
 * already yields 0 there — and only diverges on 1- and 2-vertex surfaces, which are not
 * geometry. `test/geometry/resolve.test.ts` cross-checks the formula against a literal
 * transcription of the C++ for 3..8 sides and all four corners.
 */
export function cornerShiftCount(nSides: number, corner: StartingVertexPosition): number {
  if (nSides < 1) return 0
  const c = CORNER_NUMBER[corner]
  if (nSides < 4 && c === CORNER_NUMBER.UpperRightCorner) return 0
  return (((nSides - c + 1) % nSides) + nSides) % nSides
}

export interface OrderedVertices {
  vertices: Vec3[]
  sourceIndex: number[]
}

/**
 * Apply `Vertex Entry Direction` then `Starting Vertex Position`, in that order.
 *
 * A Clockwise file is normalised by keeping vertex 1 and reversing the rest — which flips
 * the surface normal. The corner shift that follows is a pure cyclic relabel and does *not*:
 * Newell's method sums over closed edges, so rotating the start point changes nothing.
 */
export function orderVertices(
  vertices: readonly Vec3[],
  corner: StartingVertexPosition,
  direction: VertexEntryDirection,
): OrderedVertices {
  const n = vertices.length
  let index = vertices.map((_, i) => i)

  if (direction === 'Clockwise' && n > 1) {
    index = [index[0]!, ...index.slice(1).reverse()]
  }

  const shift = cornerShiftCount(n, corner)
  if (shift !== 0) index = index.map((_, i) => index[(i + shift) % n]!)

  return { vertices: index.map((i) => vertices[i]!), sourceIndex: index }
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180

interface Rotation {
  cos: number
  sin: number
}

/**
 * The angle is negated before it reaches the matrix, so a positive `North Axis` rotates the
 * building *clockwise* — the surveyor's convention, where north axis is measured clockwise
 * from true north.
 *
 * No snapping at 90/180/270: EnergyPlus takes the plain cosine, so cos(-90 deg) is 6.1e-17
 * there and here alike. Snapping would make us prettier than the simulation and, at 1e-6 m
 * tolerance, is worth nothing anyway.
 */
function rotationFor(degrees: number): Rotation {
  const t = -degrees * DEG_TO_RAD
  return { cos: Math.cos(t), sin: Math.sin(t) }
}

function rotateXY(v: Vec3, r: Rotation): Vec3 {
  return { x: v.x * r.cos - v.y * r.sin, y: v.x * r.sin + v.y * r.cos, z: v.z }
}

/** Precomputed angles, mirroring the `Cos*`/`Sin*` globals EnergyPlus sets up once per run. */
export interface TransformContext {
  coordinateSystem: CoordinateSystem
  /** Building North Axis + Appendix G. Relative coordinates only. */
  buildingRelNorth: Rotation
  /** Appendix G alone. Applies in *both* coordinate systems. */
  appendixGOnly: Rotation
  /** Zone id → its Direction of Relative North. */
  zoneRotation: Map<string, Rotation>
}

export function transformContext(model: Model): TransformContext {
  const zoneRotation = new Map<string, Rotation>()
  for (const [id, zone] of model.zones) {
    zoneRotation.set(id, rotationFor(zone.directionOfRelativeNorth))
  }
  return {
    coordinateSystem: model.rules.coordinateSystem,
    buildingRelNorth: rotationFor(model.site.northAxis + model.site.appendixGRotation),
    appendixGOnly: rotationFor(model.site.appendixGRotation),
    zoneRotation,
  }
}

/**
 * Resolve one vertex.
 *
 * Three branches, matching the three EnergyPlus takes:
 *
 *   - Relative, surface belongs to a zone — rotate by the zone's relative north, translate by
 *     the zone origin, rotate by the building's north axis (plus Appendix G), offset z.
 *   - Relative, detached building shading — building rotation only. No origin, no z offset;
 *     the object has no zone to take them from.
 *   - World — the Appendix G rotation and nothing else. Zone origin and North Axis are
 *     ignored, which is the whole meaning of World.
 *
 * Detached *site* shading (`Shading:Site:Detailed`) is exempt from all of it and is handled
 * by the caller, which passes neither a zone nor the building-shading flag.
 */
export function resolveVertex(
  v: Vec3,
  ctx: TransformContext,
  zone: Zone | undefined,
  isDetachedBuildingShading: boolean,
): Vec3 {
  if (ctx.coordinateSystem === 'World') {
    if (zone === undefined && !isDetachedBuildingShading) return v
    return rotateXY(v, ctx.appendixGOnly)
  }

  if (zone !== undefined) {
    const zr = ctx.zoneRotation.get(zone.id) ?? { cos: 1, sin: 0 }
    const xb = v.x * zr.cos - v.y * zr.sin + zone.origin.x
    const yb = v.x * zr.sin + v.y * zr.cos + zone.origin.y
    const b = ctx.buildingRelNorth
    return { x: xb * b.cos - yb * b.sin, y: xb * b.sin + yb * b.cos, z: v.z + zone.origin.z }
  }

  if (isDetachedBuildingShading) return rotateXY(v, ctx.buildingRelNorth)
  return v
}

// ---------------------------------------------------------------------------
// Newell's method
// ---------------------------------------------------------------------------

/**
 * Unit normal by Newell's method, which sums over every edge rather than picking three
 * points. That matters: IDF surfaces are routinely non-convex (an L-shaped floor, a wall
 * with a notch), and a three-point cross product taken at a reflex corner comes out
 * inverted. Newell also degrades gracefully on slightly non-planar input, returning the
 * best-fit plane's normal instead of one particular triangle's.
 *
 * Returns the zero vector — never NaN — when the polygon is degenerate.
 */
export function newellNormal(vertices: readonly Vec3[]): Vec3 {
  return normalize(newellVector(vertices))
}

/** Twice the vector area: magnitude is 2·area, direction is the unnormalised normal. */
function newellVector(vertices: readonly Vec3[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!
    const b = vertices[(i + 1) % n]!
    x += (a.y - b.y) * (a.z + b.z)
    y += (a.z - b.z) * (a.x + b.x)
    z += (a.x - b.x) * (a.y + b.y)
  }
  return { x, y, z }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (!(len > 0)) return { x: 0, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function centroidOf(vertices: readonly Vec3[]): Vec3 {
  if (vertices.length === 0) return { x: 0, y: 0, z: 0 }
  let x = 0
  let y = 0
  let z = 0
  for (const v of vertices) {
    x += v.x
    y += v.y
    z += v.z
  }
  const n = vertices.length
  return { x: x / n, y: y / n, z: z / n }
}

/**
 * Greatest perpendicular distance from any vertex to the plane through the centroid with the
 * Newell normal — a residual in metres, not a unitless score, so the UI can say "0.8 mm out
 * of plane" and a modeller can decide whether they care.
 *
 * Reported rather than corrected. EnergyPlus itself warns and carries on, and silently
 * flattening a surface would change the geometry the file describes.
 */
export function planarityResidual(vertices: readonly Vec3[], normal: Vec3, centroid: Vec3): number {
  if (vertices.length < 4) return 0
  if (normal.x === 0 && normal.y === 0 && normal.z === 0) return 0
  let worst = 0
  for (const v of vertices) {
    const d = Math.abs(
      (v.x - centroid.x) * normal.x + (v.y - centroid.y) * normal.y + (v.z - centroid.z) * normal.z,
    )
    if (d > worst) worst = d
  }
  return worst
}

// ---------------------------------------------------------------------------
// Surface resolution
// ---------------------------------------------------------------------------

/**
 * Which of the three transform branches a surface takes.
 *
 * Attached shading (`Shading:Zone:Detailed`) resolves through its base surface's zone —
 * EnergyPlus copies the zone onto it precisely so relative coordinates work. That link is
 * already resolved in `Model.zoneOf`.
 */
function zoneFor(model: Model, surface: Surface): Zone | undefined {
  const zoneId = model.zoneOf.get(surface.id)
  return zoneId === undefined ? undefined : model.zones.get(zoneId)
}

export function resolveSurface(
  model: Model,
  surface: Surface,
  ctx: TransformContext,
  rules: GeometryRules = model.rules,
): ResolvedSurface {
  const ordered = orderVertices(
    surface.vertices,
    rules.startingVertexPosition,
    rules.vertexEntryDirection,
  )

  const zone = zoneFor(model, surface)
  const isDetachedBuildingShading = surface.kind === 'shading' && surface.shadingKind === 'building'
  const worldVertices = ordered.vertices.map((v) =>
    resolveVertex(v, ctx, zone, isDetachedBuildingShading),
  )

  const vec = newellVector(worldVertices)
  const normal = normalize(vec)
  const centroid = centroidOf(worldVertices)

  return {
    id: surface.id,
    worldVertices,
    sourceIndex: ordered.sourceIndex,
    normal,
    planarityError: planarityResidual(worldVertices, normal, centroid),
    triangles: triangulate(worldVertices, normal),
    area: Math.hypot(vec.x, vec.y, vec.z) / 2,
    centroid,
  }
}

/** Resolve every surface in the model, in document order. */
export function resolveModel(model: Model): Map<string, ResolvedSurface> {
  const ctx = transformContext(model)
  const out = new Map<string, ResolvedSurface>()
  for (const id of model.surfaceOrder) {
    const surface = model.surfaces.get(id)
    if (!surface) continue
    out.set(id, resolveSurface(model, surface, ctx))
  }
  return out
}
