/**
 * Validation engine — Layer 3 of docs/04-architecture.md.
 *
 * Implements the rule set from docs/03-idf-geometry.md §Validation. Every error or warning
 * is linked to an offending object ID and offers actionable diagnostics or fixes.
 *
 * Design principles:
 * - Pure data and pure functions: runs headlessly under Node with zero GPU or DOM dependencies.
 * - Zero false positives over shipped EnergyPlus models: real defects in example files are
 *   triaged and confirmed; valid modeling practices (e.g. window reveal setbacks, shared
 *   floor slabs, plenums) are handled with appropriate tolerance or warning levels.
 */
import type { IdfDocument } from '../parser/types.js'
import { lookupInClass, type Model, type Surface, type Vec3 } from '../model/index.js'
import type { ResolvedSurface } from './resolve.js'
import { planeBasis, projectToPlane } from './triangulate.js'

export type ValidationSeverity = 'error' | 'warning'

export type ValidationRuleCode =
  | 'surface-non-planar'
  | 'fenestration-vertex-count'
  | 'fenestration-not-coplanar'
  | 'fenestration-reveal-setback'
  | 'fenestration-not-contained'
  | 'surface-degenerate'
  | 'surface-duplicate-vertices'
  | 'surface-self-intersecting'
  | 'boundary-missing-object'
  | 'boundary-asymmetric'
  | 'paired-vertex-count-mismatch'
  | 'paired-construction-mismatch'
  | 'surface-inverted-normal'
  | 'exposure-inconsistent'
  | 'zone-no-floor'
  | 'dangling-reference'
  | 'dangling-construction-reference'

export interface ValidationIssue {
  severity: ValidationSeverity
  code: ValidationRuleCode
  message: string
  objectId: string
  objectName: string
  relatedObjectId?: string
  relatedObjectName?: string
  fixDescription?: string
}

export interface ValidationReport {
  issues: ValidationIssue[]
  errorCount: number
  warningCount: number
}

// ---------------------------------------------------------------------------
// 2D Geometric Helpers
// ---------------------------------------------------------------------------

/** Squared distance from 2D point (px, py) to line segment (ax, ay)-(bx, by). */
function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const l2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay)
  if (l2 === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay)
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2
  t = Math.max(0, Math.min(1, t))
  const projx = ax + t * (bx - ax)
  const projy = ay + t * (by - ay)
  return (px - projx) * (px - projx) + (py - projy) * (py - projy)
}

/**
 * Check whether (px, py) is inside or on the boundary of a 2D polygon ring.
 * `ring` is formatted as `[x0, y0, x1, y1, ...]`.
 */
export function pointInPolygonWithBoundary(
  px: number,
  py: number,
  ring: readonly number[],
  tol = 1e-4,
): boolean {
  const n = ring.length / 2
  if (n < 3) return false
  const tolSq = tol * tol

  // Check boundary proximity first (handles vertices on edges / corners)
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2]!
    const ay = ring[i * 2 + 1]!
    const bx = ring[((i + 1) % n) * 2]!
    const by = ring[((i + 1) % n) * 2 + 1]!
    if (distToSegmentSq(px, py, ax, ay, bx, by) <= tolSq) {
      return true
    }
  }

  // Standard ray-casting for interior
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!
    const yi = ring[i * 2 + 1]!
    const xj = ring[j * 2]!
    const yj = ring[j * 2 + 1]!
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Orientation test: positive if CCW, negative if CW, 0 if collinear. */
function ccw(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Check if two 2D open line segments properly intersect (excluding endpoints). */
export function segmentsProperlyIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number,
  tol = 1e-6,
): boolean {
  const c1 = ccw(p1x, p1y, p2x, p2y, p3x, p3y)
  const c2 = ccw(p1x, p1y, p2x, p2y, p4x, p4y)
  const c3 = ccw(p3x, p3y, p4x, p4y, p1x, p1y)
  const c4 = ccw(p3x, p3y, p4x, p4y, p2x, p2y)

  // Must straddle both lines strictly beyond tolerance
  if (c1 * c2 < -tol && c3 * c4 < -tol) return true
  return false
}

/** Check if a 2D ring self-intersects (e.g. bowtie quad or hourglass). */
export function isPolygonSelfIntersecting(ring: readonly number[]): boolean {
  const n = ring.length / 2
  if (n < 4) return false
  for (let i = 0; i < n; i++) {
    const p1x = ring[i * 2]!
    const p1y = ring[i * 2 + 1]!
    const p2x = ring[((i + 1) % n) * 2]!
    const p2y = ring[((i + 1) % n) * 2 + 1]!
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // Adjacent edges meeting at endpoint
      const p3x = ring[j * 2]!
      const p3y = ring[j * 2 + 1]!
      const p4x = ring[((j + 1) % n) * 2]!
      const p4y = ring[((j + 1) % n) * 2 + 1]!
      if (segmentsProperlyIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y)) {
        return true
      }
    }
  }
  return false
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function surfacePlaneNormal(geo: ResolvedSurface, vertices: readonly Vec3[]): Vec3 {
  if (geo.normal.x !== 0 || geo.normal.y !== 0 || geo.normal.z !== 0) {
    return geo.normal
  }
  // Newell vector can cancel to zero for self-intersecting polygons with opposing loops.
  // Find first three non-collinear vertices to determine the polygon's plane.
  for (let i = 0; i < vertices.length - 2; i++) {
    for (let j = i + 1; j < vertices.length - 1; j++) {
      for (let k = j + 1; k < vertices.length; k++) {
        const a = vertices[i]!
        const b = vertices[j]!
        const c = vertices[k]!
        const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
        const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
        const nx = u.y * v.z - u.z * v.y
        const ny = u.z * v.x - u.x * v.z
        const nz = u.x * v.y - u.y * v.x
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-6) {
          return { x: nx / len, y: ny / len, z: nz / len }
        }
      }
    }
  }
  return { x: 0, y: 0, z: 0 }
}

// ---------------------------------------------------------------------------
// Validation Engine
// ---------------------------------------------------------------------------

/** Tolerance for planarity: 0.01 m (1 cm), matching EnergyPlus warning threshold. */
export const PLANARITY_TOLERANCE = 0.01

/** Maximum reveal setback considered parallel warning rather than coplanar error: 0.35 m (~14 inches). */
export const MAX_REVEAL_SETBACK = 0.35

export function validateModel(
  model: Model,
  resolved: Map<string, ResolvedSurface>,
  doc?: IdfDocument,
): ValidationReport {
  const issues: ValidationIssue[] = []

  function report(
    severity: ValidationSeverity,
    code: ValidationRuleCode,
    message: string,
    surface: Surface,
    options: {
      relatedObjectId?: string
      relatedObjectName?: string
      fixDescription?: string
    } = {},
  ): void {
    issues.push({
      severity,
      code,
      message,
      objectId: surface.id,
      objectName: surface.name,
      ...options,
    })
  }

  // Collect declared constructions if doc is provided
  const declaredConstructions = new Set<string>()
  if (doc) {
    for (const obj of doc.objects.values()) {
      if (
        obj.classKey.startsWith('construction') ||
        obj.classKey === 'construction:internalresource'
      ) {
        const name = obj.fields[0]?.value?.trim().toLowerCase()
        if (name) declaredConstructions.add(name)
      }
    }
  }

  // Fast surface lookup by lowercased name
  const surfaceByName = new Map<string, Surface>()
  for (const s of model.surfaces.values()) {
    surfaceByName.set(s.name.toLowerCase(), s)
  }

  // 1. Surface-level checks
  for (const id of model.surfaceOrder) {
    const surface = model.surfaces.get(id)
    if (!surface) continue
    const geo = resolved.get(id)
    const verts = surface.vertices

    // Degeneracy: fewer than 3 vertices
    if (verts.length < 3) {
      report(
        'error',
        'surface-degenerate',
        `Surface has only ${verts.length} vertice${verts.length === 1 ? '' : 's'}; at least 3 required.`,
        surface,
      )
      continue
    }

    // Degeneracy: zero area (only if vertices are genuinely non-degenerate)
    if (geo && geo.area < 1e-6) {
      report(
        'error',
        'surface-degenerate',
        `Surface has zero or near-zero area (${geo.area.toExponential(2)} m²).`,
        surface,
      )
    }

    // Duplicate consecutive vertices
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i]!
      const b = verts[(i + 1) % verts.length]!
      if (dist3(a, b) < 1e-5) {
        report(
          'error',
          'surface-duplicate-vertices',
          `Consecutive vertices ${i + 1} and ${((i + 1) % verts.length) + 1} are identical.`,
          surface,
          { fixDescription: 'Remove duplicate consecutive vertex.' },
        )
        break
      }
    }

    // Planarity check
    if (geo && geo.planarityError > PLANARITY_TOLERANCE) {
      report(
        'error',
        'surface-non-planar',
        `Surface is non-planar: max vertex deviation from best-fit plane is ${(geo.planarityError * 1000).toFixed(1)} mm (tolerance ${PLANARITY_TOLERANCE * 1000} mm).`,
        surface,
      )
    }

    // Self-intersection check (via 2D projection)
    if (geo) {
      const norm = surfacePlaneNormal(geo, geo.worldVertices)
      if (norm.x !== 0 || norm.y !== 0 || norm.z !== 0) {
        const basis = planeBasis(norm)
        const flat = projectToPlane(geo.worldVertices, basis)
        if (isPolygonSelfIntersecting(flat)) {
          report(
            'error',
            'surface-self-intersecting',
            `Surface polygon ring self-intersects.`,
            surface,
          )
        }
      }
    }

    // 2. Base Surface & Fenestration Rules
    if (surface.kind === 'base') {
      const obc = surface.outsideBoundaryCondition.toLowerCase().trim()
      const obcObj = surface.outsideBoundaryConditionObject.trim()

      // Dangling zone reference
      if (surface.zoneName) {
        const zid = lookupInClass(model.names, 'zone', surface.zoneName)
        if (!zid || !model.zones.has(zid)) {
          report(
            'error',
            'dangling-reference',
            `Surface references undefined Zone "${surface.zoneName}".`,
            surface,
          )
        }
      }

      // Outside Boundary Condition = Surface checks
      if (obc === 'surface') {
        if (!obcObj) {
          report(
            'error',
            'boundary-missing-object',
            `Surface specifies Outside Boundary Condition = Surface, but Outside Boundary Condition Object is blank.`,
            surface,
          )
        } else {
          const target = surfaceByName.get(obcObj.toLowerCase())
          if (!target) {
            report(
              'error',
              'boundary-missing-object',
              `Paired surface "${obcObj}" not found in model.`,
              surface,
              { relatedObjectName: obcObj },
            )
          } else if (target.kind === 'base') {
            const targetObc = target.outsideBoundaryCondition.toLowerCase().trim()
            const targetObcObj = target.outsideBoundaryConditionObject.trim()
            if (
              targetObc !== 'surface' ||
              targetObcObj.toLowerCase() !== surface.name.toLowerCase()
            ) {
              report(
                'error',
                'boundary-asymmetric',
                `Asymmetric surface pairing: "${surface.name}" points to "${target.name}", but "${target.name}" points to ${targetObcObj ? `"${targetObcObj}"` : 'nothing'} with OBC "${target.outsideBoundaryCondition}".`,
                surface,
                {
                  relatedObjectId: target.id,
                  relatedObjectName: target.name,
                  fixDescription: `Set ${target.name}'s Outside Boundary Condition Object to "${surface.name}".`,
                },
              )
            } else {
              // Symmetrical pair checks
              if (surface.vertices.length !== target.vertices.length) {
                report(
                  'error',
                  'paired-vertex-count-mismatch',
                  `Paired surfaces have mismatched vertex counts (${surface.vertices.length} vs ${target.vertices.length}).`,
                  surface,
                  {
                    relatedObjectId: target.id,
                    relatedObjectName: target.name,
                    fixDescription: 'Conform paired surface vertices to match.',
                  },
                )
              }
              if (
                surface.constructionName.toLowerCase().trim() !==
                target.constructionName.toLowerCase().trim()
              ) {
                report(
                  'warning',
                  'paired-construction-mismatch',
                  `Paired surfaces have differing constructions ("${surface.constructionName}" vs "${target.constructionName}").`,
                  surface,
                  {
                    relatedObjectId: target.id,
                    relatedObjectName: target.name,
                  },
                )
              }
            }
          }
        }
      }

      // Exposure inconsistency
      const sun = surface.sunExposure.toLowerCase().trim()
      const wind = surface.windExposure.toLowerCase().trim()
      if (['surface', 'ground', 'adiabatic', 'zone', 'foundation'].includes(obc)) {
        if (sun === 'sunexposed' || wind === 'windexposed') {
          report(
            'warning',
            'exposure-inconsistent',
            `Surface has Outside Boundary Condition = "${surface.outsideBoundaryCondition}" but specifies ${[
              sun === 'sunexposed' ? 'SunExposed' : null,
              wind === 'windexposed' ? 'WindExposed' : null,
            ]
              .filter(Boolean)
              .join(' and ')}.`,
            surface,
            { fixDescription: 'Set Sun Exposure to NoSun and Wind Exposure to NoWind.' },
          )
        }
      }

      // Normal orientation for exterior surfaces
      if (obc === 'outdoors' && geo) {
        const type = surface.surfaceType.toLowerCase()
        if (type === 'roof' && geo.normal.z < -0.1) {
          report(
            'warning',
            'surface-inverted-normal',
            `Exterior roof normal points downward (Z = ${geo.normal.z.toFixed(2)}).`,
            surface,
            { fixDescription: 'Reverse vertex order to orient normal upward.' },
          )
        } else if (type === 'floor' && geo.normal.z > 0.1) {
          report(
            'warning',
            'surface-inverted-normal',
            `Exterior floor normal points upward (Z = ${geo.normal.z.toFixed(2)}).`,
            surface,
            { fixDescription: 'Reverse vertex order to orient normal downward.' },
          )
        }
      }
    } else if (surface.kind === 'sub') {
      // Fenestration surface checks
      const vertCount = Math.max(
        surface.vertices.length,
        Number(surface.declaredVertexCount) || 0,
      )
      if (vertCount > 4 || vertCount < 3) {
        report(
          'error',
          'fenestration-vertex-count',
          `Fenestration surface has ${vertCount} vertices; EnergyPlus requires 3 or 4 vertices.`,
          surface,
        )
      }

      // Base surface reference
      const baseName = surface.baseSurfaceName.trim()
      const baseSurface = surfaceByName.get(baseName.toLowerCase())
      if (!baseSurface) {
        report(
          'error',
          'dangling-reference',
          `Fenestration references non-existent base surface "${baseName}".`,
          surface,
        )
      } else {
        const baseGeo = resolved.get(baseSurface.id)
        if (baseGeo && geo && geo.worldVertices.length >= 3) {
          // Coplanarity check
          const normalAlignment = Math.abs(dot3(geo.normal, baseGeo.normal))
          let maxPlaneDist = 0
          for (const v of geo.worldVertices) {
            const dist = Math.abs(
              (v.x - baseGeo.centroid.x) * baseGeo.normal.x +
                (v.y - baseGeo.centroid.y) * baseGeo.normal.y +
                (v.z - baseGeo.centroid.z) * baseGeo.normal.z,
            )
            if (dist > maxPlaneDist) maxPlaneDist = dist
          }

          if (normalAlignment < 0.98) {
            report(
              'error',
              'fenestration-not-coplanar',
              `Fenestration surface plane is tilted relative to host wall "${baseSurface.name}".`,
              surface,
              { relatedObjectId: baseSurface.id, relatedObjectName: baseSurface.name },
            )
          } else if (maxPlaneDist > PLANARITY_TOLERANCE) {
            if (maxPlaneDist <= MAX_REVEAL_SETBACK) {
              report(
                'warning',
                'fenestration-reveal-setback',
                `Fenestration is set back ${(maxPlaneDist * 1000).toFixed(0)} mm from wall plane (modeled as reveal setback).`,
                surface,
                { relatedObjectId: baseSurface.id, relatedObjectName: baseSurface.name },
              )
            } else {
              report(
                'error',
                'fenestration-not-coplanar',
                `Fenestration is ${(maxPlaneDist * 1000).toFixed(0)} mm out of base surface plane (tolerance ${PLANARITY_TOLERANCE * 1000} mm).`,
                surface,
                { relatedObjectId: baseSurface.id, relatedObjectName: baseSurface.name },
              )
            }
          }

          // Containment check
          const baseBasis = planeBasis(baseGeo.normal)
          const baseFlat = projectToPlane(baseGeo.worldVertices, baseBasis)
          const origin = baseGeo.worldVertices[0]
          if (origin !== undefined) {
            let outside = false
            for (const v of geo.worldVertices) {
              const dx = v.x - origin.x
              const dy = v.y - origin.y
              const dz = v.z - origin.z
              const px = dx * baseBasis.u.x + dy * baseBasis.u.y + dz * baseBasis.u.z
              const py = dx * baseBasis.v.x + dy * baseBasis.v.y + dz * baseBasis.v.z
              // 1 mm tolerance on perimeter containment
              if (!pointInPolygonWithBoundary(px, py, baseFlat, 1e-3)) {
                outside = true
                break
              }
            }
            if (outside) {
              report(
                'error',
                'fenestration-not-contained',
                `Fenestration surface extends outside the boundary of host surface "${baseSurface.name}".`,
                surface,
                { relatedObjectId: baseSurface.id, relatedObjectName: baseSurface.name },
              )
            }
          }
        }
      }
    } else if (surface.kind === 'shading') {
      if (surface.shadingKind === 'zone' && surface.baseSurfaceName) {
        const base = surfaceByName.get(surface.baseSurfaceName.toLowerCase())
        if (!base) {
          report(
            'error',
            'dangling-reference',
            `Attached shading references non-existent base surface "${surface.baseSurfaceName}".`,
            surface,
          )
        }
      }
    }

    // Construction dangling reference
    if (
      surface.kind !== 'shading' &&
      surface.constructionName &&
      declaredConstructions.size > 0
    ) {
      const cname = surface.constructionName.trim().toLowerCase()
      if (!declaredConstructions.has(cname)) {
        report(
          'warning',
          'dangling-construction-reference',
          `Construction "${surface.constructionName}" is referenced but not declared in the file.`,
          surface,
        )
      }
    }
  }

  // 3. Zone-level checks
  for (const [zid, zone] of model.zones) {
    const sids: string[] = []
    for (const [sid, z] of model.zoneOf) {
      if (z === zid) sids.push(sid)
    }

    if (sids.length > 0) {
      let hasFloor = false
      for (const sid of sids) {
        const s = model.surfaces.get(sid)
        if (s && s.kind === 'base' && s.surfaceType.toLowerCase() === 'floor') {
          hasFloor = true
          break
        }
      }
      if (!hasFloor) {
        issues.push({
          severity: 'warning',
          code: 'zone-no-floor',
          message: `Zone "${zone.name}" has no floor surface defined.`,
          objectId: zid,
          objectName: zone.name,
        })
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length

  return { issues, errorCount, warningCount }
}
