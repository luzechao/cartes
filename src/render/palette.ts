/**
 * Colour — the "colour by surface type / by construction" half of Phase 3.
 *
 * Pure data and pure functions, no three.js scene objects, so the mapping can be tested
 * without a GPU and reused by the legend in Layer 5.
 *
 * The surface-type palette follows the OpenStudio convention rather than inventing one.
 * Anyone doing BEM review has spent years looking at tan walls, grey floors and brick-red
 * roofs; a viewer that recolours them is harder to read even if the new colours are prettier.
 */
import { Color } from 'three'
import type { Surface } from '../model/index.js'

export type SurfaceCategory =
  | 'wall'
  | 'floor'
  | 'roof'
  | 'ceiling'
  | 'window'
  | 'glassdoor'
  | 'door'
  | 'shading'
  | 'other'

/**
 * `other` is deliberately magenta. Every surface type in the 182-file corpus maps to one of
 * the named categories, so an unclassified surface means an assumption has broken — better
 * that it shouts than that it blends in as another grey wall.
 */
export const SURFACE_TYPE_COLORS: Readonly<Record<SurfaceCategory, number>> = {
  wall: 0xc8b48c,
  floor: 0x808080,
  roof: 0x994c4c,
  ceiling: 0xc0c0c0,
  window: 0x66b2cc,
  glassdoor: 0x66b2cc,
  door: 0x99854c,
  shading: 0xcccc66,
  other: 0xff00ff,
}

/** Categories whose material is translucent, so what is behind the glass stays visible. */
export const GLAZED: ReadonlySet<SurfaceCategory> = new Set<SurfaceCategory>([
  'window',
  'glassdoor',
])

/**
 * IDF surface types are case-insensitive and files use every casing there is — the corpus
 * has `Wall`, `WALL` and `wall`, `GLASSDOOR` and `GlassDoor`. Matching on the lower-cased
 * value with punctuation stripped covers all of it, and `GlazedDoor` too, which is the Tier-3
 * spelling of the same thing.
 */
function normaliseType(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '')
}

const BASE_CATEGORY: Readonly<Record<string, SurfaceCategory>> = {
  wall: 'wall',
  floor: 'floor',
  roof: 'roof',
  ceiling: 'ceiling',
}

const SUB_CATEGORY: Readonly<Record<string, SurfaceCategory>> = {
  window: 'window',
  glassdoor: 'glassdoor',
  glazeddoor: 'glassdoor',
  door: 'door',
  tubulardaylightdome: 'window',
  tubulardaylightdiffuser: 'window',
}

/** The display category of a surface. All three shading kinds share one colour. */
export function surfaceCategory(surface: Surface): SurfaceCategory {
  if (surface.kind === 'shading') return 'shading'
  const table = surface.kind === 'base' ? BASE_CATEGORY : SUB_CATEGORY
  return table[normaliseType(surface.surfaceType)] ?? 'other'
}

/**
 * A stable colour for a construction name.
 *
 * Hashed from the name rather than assigned by position in a sorted list, so a construction's
 * colour does not shift when an unrelated one is added or deleted — with a live-editing tool
 * the whole model changing colour on an edit is disorienting and looks like a bug. The cost
 * is that two constructions can collide on a similar hue; the legend, not the colour, is what
 * identifies them.
 *
 * Saturation and lightness are fixed mid-range so nothing lands on white (invisible against
 * the background) or black (invisible against its own edges).
 */
export function constructionColor(name: string): number {
  const key = name.trim().toLowerCase()
  if (key === '') return SURFACE_TYPE_COLORS.other

  // FNV-1a, 32-bit. Chosen for being short, seedless and well spread on short strings.
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return new Color().setHSL((hash % 360) / 360, 0.55, 0.55).getHex()
}
