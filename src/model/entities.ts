/**
 * Typed entities — Layer 2 of docs/04-architecture.md.
 *
 * A *projection* of the classes we understand, not a replacement for the document. Two rules
 * keep it honest:
 *
 *   1. `vertices` holds the file's values as written. Coordinate resolution happens in the
 *      geometry layer and is never written back, or a `Relative` file would silently become
 *      a `World` file on save.
 *   2. Writes back to the document are field-level, so an edited object differs from its
 *      original in exactly the fields that changed.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export type StartingVertexPosition =
  | 'UpperLeftCorner'
  | 'LowerLeftCorner'
  | 'LowerRightCorner'
  | 'UpperRightCorner'

export type VertexEntryDirection = 'Counterclockwise' | 'Clockwise'
export type CoordinateSystem = 'Relative' | 'World'

/**
 * `GlobalGeometryRules` — governs the interpretation of every vertex in the file.
 *
 * EPShape omits this class entirely, which is why it cannot honour relative coordinates.
 */
export interface GeometryRules {
  /** Object id, absent when the file declares no `GlobalGeometryRules`. */
  id?: string
  startingVertexPosition: StartingVertexPosition
  vertexEntryDirection: VertexEntryDirection
  coordinateSystem: CoordinateSystem
  /** Applies to daylighting reference points — preserved, not yet used. */
  daylightingReferencePointCoordinateSystem: CoordinateSystem
  /** Applies to the Tier 3 rectangular classes — preserved, load-bearing once they render. */
  rectangularSurfaceCoordinateSystem: CoordinateSystem
}

/** Building-level rotations, in degrees clockwise from true north. */
export interface SiteRules {
  buildingId?: string
  complianceId?: string
  /** `Building` `North Axis`. Applies to relative coordinates only. */
  northAxis: number
  /**
   * `Compliance:Building` `Building Rotation for Appendix G`. Applies **even in World
   * coordinates** — see docs/03-idf-geometry.md §The Appendix G trap.
   */
  appendixGRotation: number
}

export interface Zone {
  id: string
  name: string
  /** `Direction of Relative North`, degrees clockwise. */
  directionOfRelativeNorth: number
  origin: Vec3
  multiplier: number
  type: string
  ceilingHeight?: number
  volume?: number
  floorArea?: number
}

/** `Space`, added in 9.6. Surfaces may name a space instead of a zone. */
export interface Space {
  id: string
  name: string
  zoneName: string
}

export type SurfaceKind = 'base' | 'sub' | 'shading'
export type ShadingKind = 'site' | 'building' | 'zone'

interface SurfaceCommon {
  id: string
  name: string
  /** As written, e.g. `BuildingSurface:Detailed`. */
  className: string
  classKey: string
  /** Vertices **as written in the file** — not coordinate-resolved. */
  vertices: Vec3[]
  /** Raw `Number of Vertices` field, which is often `autocalculate` or blank. */
  declaredVertexCount: string
}

/** `BuildingSurface:Detailed` and the Tier 2 `Wall:` / `RoofCeiling:` / `Floor:Detailed`. */
export interface BuildingSurface extends SurfaceCommon {
  kind: 'base'
  /**
   * `Wall` | `Floor` | `Roof` | `Ceiling`. For the Tier 2 classes the IDF carries no such
   * field and the type is implied by the class name; EnergyPlus then reclassifies roof
   * versus ceiling by tilt, which is a rendering concern rather than a model one.
   */
  surfaceType: string
  constructionName: string
  zoneName: string
  spaceName: string
  outsideBoundaryCondition: string
  outsideBoundaryConditionObject: string
  sunExposure: string
  windExposure: string
  /** Ids of `FenestrationSurface:Detailed` objects naming this surface. */
  subSurfaces: string[]
  /** Ids of `Shading:Zone:Detailed` objects naming this surface. */
  attachedShading: string[]
}

/** `FenestrationSurface:Detailed` — windows, doors, glazed doors. Capped at 4 vertices. */
export interface SubSurface extends SurfaceCommon {
  kind: 'sub'
  surfaceType: string
  constructionName: string
  baseSurfaceName: string
  outsideBoundaryConditionObject: string
  frameAndDividerName: string
  multiplier: number
  attachedShading: string[]
}

export interface ShadingSurface extends SurfaceCommon {
  kind: 'shading'
  shadingKind: ShadingKind
  /** Only for `Shading:Zone:Detailed`. */
  baseSurfaceName: string
  transmittanceScheduleName: string
}

export type Surface = BuildingSurface | SubSurface | ShadingSurface

export interface ModelDiagnostic {
  severity: 'error' | 'warning' | 'info'
  /** Stable machine-readable tag, for suppression and for tests. */
  code: string
  message: string
  objectId?: string
}
