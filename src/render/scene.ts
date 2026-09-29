/**
 * Scene construction — Layer 4 of docs/04-architecture.md.
 *
 * Builds a three.js graph from a `Model` and its resolved geometry, and nothing else: no
 * renderer, no camera, no DOM. That separation is not tidiness, it is testability —
 * `WebGLRenderer` needs a GPU and does not run under Node, while everything here does, so the
 * structure of the scene can be asserted in tests and only the pixels need a browser.
 *
 * ## The one coordinate conversion
 *
 * EnergyPlus is Z-up, three.js is Y-up. Every vertex in this codebase stays in the
 * EnergyPlus frame; the conversion is a single rotation on `root`, applied by the GPU
 * (docs/03-idf-geometry.md §Units and axes). Convert in more than one place and eventually a
 * flipped axis gets written back into somebody's file.
 */
import { Group, Mesh } from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import type { Model, Surface, Vec3 } from '../model/index.js'
import type { ResolvedSurface } from '../geometry/index.js'
import { FENESTRATION_OFFSET, surfaceEdgePositions, surfaceGeometry } from './geometry.js'
import { MaterialCache } from './materials.js'
import { constructionColor, SURFACE_TYPE_COLORS, surfaceCategory } from './palette.js'
import { SceneRegistry, type SceneEntry } from './registry.js'

/** Rotate −90° about X: EnergyPlus (x, y, z) is drawn at three.js (x, z, −y). */
export const Z_UP_TO_Y_UP = -Math.PI / 2

export type ColorBy = 'type' | 'construction'

export interface SceneOptions {
  colorBy: ColorBy
  /** Metres to push fenestration off its base surface. Zero disables the nudge entirely. */
  fenestrationOffset: number
}

const DEFAULTS: SceneOptions = {
  colorBy: 'type',
  fenestrationOffset: FENESTRATION_OFFSET,
}

export interface SceneBuild {
  /** Carries the Z-up → Y-up rotation. Add this to a scene; nothing else transforms. */
  root: Group
  registry: SceneRegistry
  materials: MaterialCache
  /** Surfaces the model knows about that had no resolved geometry to draw. */
  skipped: string[]
  /** The options the build was made with, so a partial refresh draws the same way. */
  options: SceneOptions
}

/** Where in its family a surface sits, and which surface the family is anchored to. */
export interface OffsetPlan {
  /** Levels of nesting above the base surface. Zero for a base or detached surface. */
  depth: number
  /** The base surface at the root of the chain. */
  rootId: string
}

/**
 * Plan the fenestration nudge for every surface.
 *
 * Fenestration is coplanar with its wall, and coplanar polygons z-fight. Two decisions here:
 *
 * *Depth* is one step per level of nesting, not a flat offset, because a
 * `Shading:Zone:Detailed` attached to a window has to clear the window, which has already
 * cleared the wall.
 *
 * *Direction* is the **base surface's** normal for the whole family, not each surface's own.
 * Its own would usually do — a window is coplanar with its wall — but "usually" is doing real
 * work there: a window whose vertices run the other way has an inverted normal and would be
 * nudged straight into the wall, which is the z-fight the offset exists to prevent. Anchoring
 * the family to the base means a mis-wound child still moves outward with its siblings.
 *
 * Walked from each surface up to its root rather than down from the roots, so nothing depends
 * on parents appearing before children in the file — EnergyPlus resolves these links by name
 * after the whole file is read and imposes no declaration order.
 */
function offsetPlans(model: Model): Map<string, OffsetPlan> {
  const parents = new Map<string, string>()
  for (const id of model.surfaceOrder) {
    const surface = model.surfaces.get(id)
    if (!surface) continue
    for (const childId of childrenOf(surface)) parents.set(childId, id)
  }

  const plans = new Map<string, OffsetPlan>()
  for (const start of parents.keys()) {
    if (plans.has(start)) continue
    const chain: string[] = []
    const seen = new Set<string>()
    let cursor = start
    let base: OffsetPlan = { depth: 0, rootId: start }

    for (;;) {
      const known = plans.get(cursor)
      if (known !== undefined) {
        base = known
        break
      }
      const next = parents.get(cursor)
      // A malformed file can name a cycle; `seen` stops it, and everything in the cycle is
      // anchored to an arbitrary member — z-fighting rather than not drawn at all.
      if (next === undefined || seen.has(cursor)) {
        base = { depth: 0, rootId: cursor }
        break
      }
      seen.add(cursor)
      chain.push(cursor)
      cursor = next
    }

    for (let i = chain.length - 1; i >= 0; i--) {
      plans.set(chain[i]!, { depth: base.depth + chain.length - i, rootId: base.rootId })
    }
  }
  return plans
}

function childrenOf(surface: Surface): readonly string[] {
  if (surface.kind === 'base') return [...surface.subSurfaces, ...surface.attachedShading]
  if (surface.kind === 'sub') return surface.attachedShading
  return []
}

function isZero(v: Vec3): boolean {
  return v.x === 0 && v.y === 0 && v.z === 0
}

export function entryColor(entry: SceneEntry, colorBy: ColorBy): number {
  if (colorBy === 'construction' && entry.category !== 'shading') {
    return constructionColor(entry.constructionName)
  }
  return SURFACE_TYPE_COLORS[entry.category]
}

/**
 * Build the scene graph.
 *
 * One `Group` per surface, holding a filled `Mesh` and a `LineSegments2` outline. Grouping
 * them means visibility, selection highlighting and removal are one operation on one object
 * rather than two kept in step — and the group is what the registry hands back.
 */
export function buildScene(
  model: Model,
  resolved: Map<string, ResolvedSurface>,
  options: Partial<SceneOptions> = {},
): SceneBuild {
  const opts: SceneOptions = { ...DEFAULTS, ...options }
  const root = new Group()
  root.name = 'cartes:root'
  root.rotation.x = Z_UP_TO_Y_UP

  const registry = new SceneRegistry()
  const materials = new MaterialCache()
  const skipped: string[] = []

  const plans = offsetPlans(model)

  for (const id of model.surfaceOrder) {
    const surface = model.surfaces.get(id)
    const geo = resolved.get(id)
    if (!surface || !geo || geo.worldVertices.length < 2) {
      if (surface) skipped.push(id)
      continue
    }

    const plan = plans.get(id)
    const offset = (plan?.depth ?? 0) * opts.fenestrationOffset
    // Fall back to the surface's own normal when the base surface's is degenerate. Offsetting
    // along a zero vector is a harmless no-op; reaching it through a division by zero would
    // put NaN in the vertex buffer, which is not.
    const anchor = plan === undefined ? undefined : resolved.get(plan.rootId)?.normal
    const direction = anchor !== undefined && !isZero(anchor) ? anchor : geo.normal

    const category = surfaceCategory(surface)
    const constructionName = surface.kind === 'shading' ? '' : surface.constructionName
    const zoneId = model.zoneOf.get(id)
    const zone = zoneId === undefined ? undefined : model.zones.get(zoneId)

    const group = new Group()
    group.name = surface.name

    const mesh = new Mesh(
      surfaceGeometry(geo, offset, direction),
      materials.mesh(SURFACE_TYPE_COLORS[category], category),
    )
    mesh.name = `${surface.name}:mesh`

    const edgeGeometry = new LineSegmentsGeometry()
    edgeGeometry.setPositions(new Float32Array(surfaceEdgePositions(geo, offset, direction)))
    const edges = new LineSegments2(edgeGeometry, materials.line())
    edges.name = `${surface.name}:edges`
    // Picking is done against meshes; an outline is a hairline and a miserable target.
    edges.raycast = () => {}

    group.add(mesh, edges)
    root.add(group)

    const entry: SceneEntry = {
      id,
      name: surface.name,
      className: surface.className,
      category,
      constructionName,
      object: group,
      mesh,
      edges,
    }
    if (zoneId !== undefined) entry.zoneId = zoneId
    if (zone !== undefined) entry.zoneName = zone.name
    registry.add(entry)
  }

  if (opts.colorBy !== 'type') applyColorBy(registry, materials, opts.colorBy)
  return { root, registry, materials, skipped, options: opts }
}

/**
 * Redraw the geometry of some surfaces in place — the per-frame path of a drag.
 *
 * Rebuilding the whole scene on every pointer move would re-tessellate every surface in the
 * file to move one corner. This swaps the mesh and outline buffers of the named surfaces only,
 * leaving materials, selection and everything else untouched. Surfaces not in the build (or
 * whose geometry has collapsed below two vertices) are returned so the caller can fall back to
 * a full rebuild; a partial refresh is never allowed to silently drop a surface.
 */
export function refreshSurfaces(
  build: SceneBuild,
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  ids: Iterable<string>,
): string[] {
  const plans = offsetPlans(model)
  const unrefreshed: string[] = []
  for (const id of ids) {
    const entry = build.registry.get(id)
    const geo = resolved.get(id)
    if (!entry || !geo || geo.worldVertices.length < 2) {
      unrefreshed.push(id)
      continue
    }
    const plan = plans.get(id)
    const offset = (plan?.depth ?? 0) * build.options.fenestrationOffset
    const anchor = plan === undefined ? undefined : resolved.get(plan.rootId)?.normal
    const direction = anchor !== undefined && !isZero(anchor) ? anchor : geo.normal

    entry.mesh.geometry.dispose()
    entry.mesh.geometry = surfaceGeometry(geo, offset, direction)
    const edgeGeometry = new LineSegmentsGeometry()
    edgeGeometry.setPositions(new Float32Array(surfaceEdgePositions(geo, offset, direction)))
    const edges = entry.edges as LineSegments2
    edges.geometry.dispose()
    edges.geometry = edgeGeometry
  }
  return unrefreshed
}

/**
 * Recolour in place.
 *
 * Switching the colour mode swaps materials on existing meshes rather than rebuilding the
 * scene: geometry is the expensive part, colour is not, and rebuilding would drop selection
 * and camera-relative state for a change that is purely cosmetic.
 */
export function applyColorBy(
  registry: SceneRegistry,
  materials: MaterialCache,
  colorBy: ColorBy,
): void {
  for (const entry of registry) {
    entry.mesh.material = materials.mesh(entryColor(entry, colorBy), entry.category)
  }
}
