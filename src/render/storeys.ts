/**
 * Storeys and storey display modes — Phase 9 of docs/05-implementation-plan.md.
 *
 * Borrowed from Pascal's level display modes. A multi-storey building seen whole hides its inner
 * floors; pulling the storeys apart (exploded) or showing one at a time (solo) is how a reviewer
 * checks each floor plate. Headless, like `scene.ts`: the grouping is plain geometry and the
 * display is a transform on the scene graph, so both are tested without a GPU.
 */
import type { Model } from '../model/index.js'
import type { ResolvedSurface } from '../geometry/index.js'
import type { SceneBuild } from './scene.js'

export interface Storey {
  /** 0 for the lowest. */
  index: number
  /** Floor elevation: the lowest floor among its zones, world z. */
  z: number
  zoneIds: string[]
}

export interface StoreyMap {
  storeys: Storey[]
  /** Zone id → storey index. */
  ofZone: Map<string, number>
}

/**
 * Group zones into storeys by floor elevation.
 *
 * A zone's elevation is the lowest vertex of its floors, or of all its surfaces when it has none
 * (an attic, a plenum drawn with a ceiling only). Zones within `tolerance` of the storey's first
 * elevation share it, so a split-level half a metre up stays on the same storey while a floor a
 * full storey up does not.
 */
export function computeStoreys(
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  tolerance = 0.5,
): StoreyMap {
  const floorZ = new Map<string, number>()
  const anyZ = new Map<string, number>()
  for (const [id, zid] of model.zoneOf) {
    const s = model.surfaces.get(id)
    const r = resolved.get(id)
    if (!s || !r || r.worldVertices.length === 0) continue
    const z = Math.min(...r.worldVertices.map((v) => v.z))
    anyZ.set(zid, Math.min(anyZ.get(zid) ?? Infinity, z))
    if (s.kind === 'base' && s.surfaceType.trim().toLowerCase() === 'floor') {
      floorZ.set(zid, Math.min(floorZ.get(zid) ?? Infinity, z))
    }
  }
  const elevations = [...model.zones.keys()]
    .map((zid) => ({ zid, z: floorZ.get(zid) ?? anyZ.get(zid) }))
    .filter((e): e is { zid: string; z: number } => e.z !== undefined)
    .sort((a, b) => a.z - b.z)

  const storeys: Storey[] = []
  const ofZone = new Map<string, number>()
  for (const { zid, z } of elevations) {
    const last = storeys[storeys.length - 1]
    if (last && z - last.z <= tolerance) {
      last.zoneIds.push(zid)
      ofZone.set(zid, last.index)
    } else {
      storeys.push({ index: storeys.length, z, zoneIds: [zid] })
      ofZone.set(zid, storeys.length - 1)
    }
  }
  return { storeys, ofZone }
}

export type StoreyDisplay =
  | { mode: 'stacked' }
  | { mode: 'exploded'; gap?: number }
  | { mode: 'solo'; storey: number }

/**
 * The extra separation `exploded` adds between consecutive storeys: the tallest floor-to-floor
 * height, so each storey clears the one below by at least its own height again.
 */
export function explodeGap(map: StoreyMap): number {
  let tallest = 0
  for (let i = 1; i < map.storeys.length; i++) tallest = Math.max(tallest, map.storeys[i]!.z - map.storeys[i - 1]!.z)
  return Math.max(tallest, 3)
}

/**
 * Apply a storey display to a built scene, in place. Surfaces with no zone (detached shading)
 * stay where they are, and are hidden in `solo`.
 *
 * Offsets are along the model's z, on each surface's group — the groups sit under the root that
 * carries the Z-up → Y-up rotation, so a group's local z *is* the model's z.
 */
export function applyStoreyDisplay(build: SceneBuild, map: StoreyMap, display: StoreyDisplay): void {
  const gap = display.mode === 'exploded' ? (display.gap ?? explodeGap(map)) : 0
  for (const entry of build.registry) {
    const storey = entry.zoneId === undefined ? undefined : map.ofZone.get(entry.zoneId)
    entry.object.position.set(0, 0, display.mode === 'exploded' && storey !== undefined ? storey * gap : 0)
    entry.object.visible = display.mode === 'solo' ? storey === display.storey : true
  }
}
