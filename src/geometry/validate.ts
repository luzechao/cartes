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
 *
 * Derived from EnergyPlus source code; see NOTICE for its copyright notice and license.
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
  | 'zone-not-enclosed'
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

const UPSIDE_DOWN = 1e-6

/** E+ `CalculateZoneVolume` builds the zone polyhedron from these surface classes only. */
const ENCLOSING_TYPES = new Set(['wall', 'floor', 'roof', 'ceiling'])

/** EnergyPlus's `Constant::OneCentimeter`, the tolerance of every enclosure comparison. */
const ENCLOSURE_TOL = 0.01

function fmtPt(p: Vec3): string {
  return `(${+p.x.toFixed(2)}, ${+p.y.toFixed(2)}, ${+p.z.toFixed(2)})`
}

function almostEqual(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a.x - b.x) < ENCLOSURE_TOL && Math.abs(a.y - b.y) < ENCLOSURE_TOL && Math.abs(a.z - b.z) < ENCLOSURE_TOL
  )
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** EnergyPlus's `isPointOnLineBetweenPoints`: within 1 cm of the line, and between the ends. */
function onSegment(s: Vec3, e: Vec3, t: Vec3): boolean {
  const len = dist(s, e)
  if (len === 0) return false
  const d = { x: (e.x - s.x) / len, y: (e.y - s.y) / len, z: (e.z - s.z) / len }
  const o = { x: t.x - s.x, y: t.y - s.y, z: t.z - s.z }
  const c = { x: d.y * o.z - d.z * o.y, y: d.z * o.x - d.x * o.z, z: d.x * o.y - d.y * o.x }
  if (Math.hypot(c.x, c.y, c.z) >= ENCLOSURE_TOL) return false
  return Math.abs(len - (dist(s, t) + dist(t, e))) < ENCLOSURE_TOL
}

export interface OpenEdge {
  a: Vec3
  b: Vec3
  /** How many faces use this edge. An enclosed zone uses every edge exactly twice. */
  count: number
  /** Index of the first face using it. */
  face: number
}

function edgesNotTwo(faces: readonly Vec3[][], unique: readonly Vec3[]): OpenEdge[] {
  const indexOf = (p: Vec3): number => unique.findIndex((u) => almostEqual(u, p))
  const edges = new Map<string, OpenEdge>()
  faces.forEach((ring, f) => {
    for (let j = 0; j < ring.length; j++) {
      const a = indexOf(ring[(j - 1 + ring.length) % ring.length]!)
      const b = indexOf(ring[j]!)
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const e = edges.get(key)
      if (e) e.count++
      else edges.set(key, { a: unique[a]!, b: unique[b]!, count: 1, face: f })
    }
  })
  return [...edges.values()].filter((e) => e.count !== 2)
}

/**
 * Edges of a set of faces not shared by exactly two of them — EnergyPlus's
 * `isEnclosedVolume`, transcribed.
 *
 * Vertices are merged at 1 cm per axis, in first-seen order. When the first count finds open
 * edges, every face has any other face's vertex lying on one of its edges inserted there — the
 * T-junction where two collinear walls meet under one long floor edge — and the count is redone.
 * The zone is enclosed exactly when either pass finds nothing open — the same decision
 * EnergyPlus makes. For the report, edges open in *both* passes are preferred, as EnergyPlus
 * lists them; when there are none (every open edge is one the repair pass created), the second
 * pass's edges are returned instead, so a non-empty result always means "not enclosed".
 */
export function openEdges(faces: readonly Vec3[][]): OpenEdge[] {
  const unique: Vec3[] = []
  for (const ring of faces) for (const p of ring) if (!unique.some((u) => almostEqual(u, p))) unique.push(p)

  const first = edgesNotTwo(faces, unique)
  if (first.length === 0) return []

  const updated = faces.map((ring) => {
    const out = [...ring]
    let inserted = true
    while (inserted) {
      inserted = false
      for (let i = 0; i < out.length && !inserted; i++) {
        const cur = out[i]!
        const next = out[(i + 1) % out.length]!
        for (const t of unique) {
          if (!almostEqual(cur, t) && !almostEqual(next, t) && onSegment(cur, next, t)) {
            out.splice(i + 1, 0, t)
            inserted = true
            break
          }
        }
      }
    }
    return out
  })
  const again = edgesNotTwo(updated, unique)
  if (again.length === 0) return []
  const same = (x: OpenEdge, y: OpenEdge): boolean =>
    (almostEqual(x.a, y.a) && almostEqual(x.b, y.b)) || (almostEqual(x.a, y.b) && almostEqual(x.b, y.a))
  const inBoth = first.filter((e) => again.some((g) => same(e, g)))
  return inBoth.length > 0 ? inBoth : again
}

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

      // Upside-down floors and roofs — EnergyPlus's `GetVertices` test, whatever the boundary
      // condition: a floor whose normal has any upward component, or a roof or ceiling with any
      // downward one, at 1e-6 on the unit normal. EnergyPlus reverses the surface and warns. The
      // first version of this rule looked only at `Outdoors` surfaces, with a 0.1 threshold, and
      // so missed an upside-down ground floor that EnergyPlus reported.
      if (geo) {
        const type = surface.surfaceType.toLowerCase()
        if ((type === 'roof' || type === 'ceiling') && geo.normal.z < -UPSIDE_DOWN) {
          report(
            'warning',
            'surface-inverted-normal',
            `${surface.surfaceType} faces downward (normal Z = ${geo.normal.z.toFixed(2)}); EnergyPlus will reverse it.`,
            surface,
            { fixDescription: 'Reverse vertex order so the normal points up, out of the zone.' },
          )
        } else if (type === 'floor' && geo.normal.z > UPSIDE_DOWN) {
          report(
            'warning',
            'surface-inverted-normal',
            `Floor faces upward (normal Z = ${geo.normal.z.toFixed(2)}); EnergyPlus will reverse it.`,
            surface,
            { fixDescription: 'Reverse vertex order so the normal points down, out of the zone.' },
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

  // Surfaces with `Outside Boundary Condition = Zone` (or `Space`) get a reversed twin created
  // by EnergyPlus inside the named zone. Measured: without these, a return plenum whose floor is
  // made entirely of the ceilings below it — `ASHRAE901_OfficeLarge…`, and two other corpus
  // files — reads as open, while EnergyPlus correctly finds it enclosed.
  const autoTwins = new Map<string, Vec3[][]>()
  for (const s of model.surfaces.values()) {
    if (s.kind !== 'base' || !ENCLOSING_TYPES.has(s.surfaceType.trim().toLowerCase())) continue
    const bc = s.outsideBoundaryCondition.trim().toLowerCase()
    if (bc !== 'zone' && bc !== 'space') continue
    let target = lookupInClass(model.names, 'zone', s.outsideBoundaryConditionObject)
    if (target === undefined && bc === 'space') {
      const spaceId = lookupInClass(model.names, 'space', s.outsideBoundaryConditionObject)
      const space = spaceId === undefined ? undefined : model.spaces.get(spaceId)
      if (space) target = lookupInClass(model.names, 'zone', space.zoneName)
    }
    const g = resolved.get(s.id)
    if (target === undefined || !g || g.worldVertices.length < 3) continue
    const list = autoTwins.get(target) ?? []
    list.push([...g.worldVertices].reverse())
    autoTwins.set(target, list)
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

      const faces: Array<{ id: string; ring: Vec3[] }> = []
      for (const sid of sids) {
        const s = model.surfaces.get(sid)
        const g = resolved.get(sid)
        if (!s || s.kind !== 'base' || !g || g.worldVertices.length < 3) continue
        if (!ENCLOSING_TYPES.has(s.surfaceType.trim().toLowerCase())) continue
        faces.push({ id: sid, ring: g.worldVertices })
      }
      const twins = autoTwins.get(zid) ?? []
      const open = faces.length > 0 ? openEdges([...faces.map((f) => f.ring), ...twins]) : []
      if (open.length > 0) {
        const own = open.filter((e) => e.face < faces.length)
        const first = faces[(own[0] ?? open[0]!).face] ?? faces[0]!
        const where = open
          .slice(0, 3)
          .map((e) => `${model.surfaces.get(faces[e.face]?.id ?? '')?.name ?? '(auto-created twin)'} ${fmtPt(e.a)}–${fmtPt(e.b)} (${e.count}×)`)
          .join('; ')
        issues.push({
          severity: 'warning',
          code: 'zone-not-enclosed',
          message:
            `Zone "${zone.name}" is not fully enclosed: ${open.length} edge${open.length === 1 ? ' is' : 's are'} ` +
            `not shared by exactly two of its walls, floors and roofs — ${where}${open.length > 3 ? ', …' : ''}. ` +
            'EnergyPlus will warn and fall back to an approximate volume.',
          objectId: first.id,
          objectName: model.surfaces.get(first.id)?.name ?? '',
          relatedObjectId: zid,
          relatedObjectName: zone.name,
          fixDescription: 'Make every edge of the zone meet exactly one other surface edge — snap corners together, or split long edges where neighbours meet them.',
        })
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length

  return { issues, errorCount, warningCount }
}
