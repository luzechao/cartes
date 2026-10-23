/**
 * Stories and story display modes — Phase 9 of docs/05-implementation-plan.md.
 *
 * Borrowed from Pascal's level display modes. A multi-story building seen whole hides its inner
 * floors; pulling the stories apart (exploded) or showing one at a time (solo) is how a reviewer
 * checks each floor plate. Headless, like `scene.ts`: the grouping is plain geometry and the
 * display is a transform on the scene graph, so both are tested without a GPU.
 */
import type { Model } from '../model/index.js'
import type { ResolvedSurface } from '../geometry/index.js'
import type { SceneBuild } from './scene.js'

export interface Story {
  /** 0 for the lowest. */
  index: number
  /** Floor elevation: the lowest floor among its zones, world z. */
  z: number
  zoneIds: string[]
}

export interface StoryMap {
  stories: Story[]
  /** Zone id → story index. */
  ofZone: Map<string, number>
}

/**
 * Group zones into stories by floor elevation.
 *
 * A zone's elevation is the lowest vertex of its floors, or of all its surfaces when it has none
 * (an attic, a plenum drawn with a ceiling only). Zones within `tolerance` of the story's first
 * elevation share it, so a split-level half a metre up stays on the same story while a floor a
 * full story up does not.
 */
export function computeStories(
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  tolerance = 0.5,
): StoryMap {
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

  const stories: Story[] = []
  const ofZone = new Map<string, number>()
  for (const { zid, z } of elevations) {
    const last = stories[stories.length - 1]
    if (last && z - last.z <= tolerance) {
      last.zoneIds.push(zid)
      ofZone.set(zid, last.index)
    } else {
      stories.push({ index: stories.length, z, zoneIds: [zid] })
      ofZone.set(zid, stories.length - 1)
    }
  }
  return { stories, ofZone }
}

export type StoryDisplay =
  | { mode: 'stacked' }
  | { mode: 'exploded'; gap?: number }
  | { mode: 'solo'; story: number }

/**
 * The extra separation `exploded` adds between consecutive stories: the tallest floor-to-floor
 * height, so each story clears the one below by at least its own height again.
 */
export function explodeGap(map: StoryMap): number {
  let tallest = 0
  for (let i = 1; i < map.stories.length; i++) tallest = Math.max(tallest, map.stories[i]!.z - map.stories[i - 1]!.z)
  return Math.max(tallest, 3)
}

/**
 * Apply a story display to a built scene, in place. Surfaces with no zone (detached shading)
 * stay where they are, and are hidden in `solo`.
 *
 * Offsets are along the model's z, on each surface's group — the groups sit under the root that
 * carries the Z-up → Y-up rotation, so a group's local z *is* the model's z.
 */
export function applyStoryDisplay(build: SceneBuild, map: StoryMap, display: StoryDisplay): void {
  const gap = display.mode === 'exploded' ? (display.gap ?? explodeGap(map)) : 0
  for (const entry of build.registry) {
    const story = entry.zoneId === undefined ? undefined : map.ofZone.get(entry.zoneId)
    entry.object.position.set(0, 0, display.mode === 'exploded' && story !== undefined ? story * gap : 0)
    entry.object.visible = display.mode === 'solo' ? story === display.story : true
  }
}
