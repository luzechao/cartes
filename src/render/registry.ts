/**
 * Scene registry — Layer 4 of docs/04-architecture.md, borrowed from Pascal Editor.
 *
 * A two-way map between document object ids and the `Object3D`s that draw them, plus
 * category and zone indices. The point is that **picking, selection and visibility never
 * traverse the scene graph**: a raycast hit is one map lookup, "hide zone 3" is one array,
 * and "recolour every window" does not walk 8000 objects to find 400.
 *
 * The registry owns nothing it did not receive. `dispose` releases the GPU resources of the
 * geometries and the meshes' own materials; shared materials belong to the material cache.
 */
import type { Mesh, Object3D } from 'three'
import type { SurfaceCategory } from './palette.js'

export interface SceneEntry {
  /** The document object id. The same id the parser, model and undo stack use. */
  id: string
  name: string
  className: string
  category: SurfaceCategory
  /** Blank for shading, which has no construction. */
  constructionName: string
  /** Absent for detached shading, which belongs to no zone. */
  zoneId?: string
  zoneName?: string
  /** The group holding the mesh and its edges; this is what visibility toggles. */
  object: Object3D
  mesh: Mesh
  /** `LineSegments2`, typed loosely so this module does not depend on the addons. */
  edges: Object3D
}

const EMPTY: readonly string[] = []

export class SceneRegistry {
  private readonly entries = new Map<string, SceneEntry>()
  /** `Object3D.id` → document id, for both the mesh and its edges. */
  private readonly byObject = new Map<number, string>()
  private readonly categories = new Map<SurfaceCategory, string[]>()
  private readonly zones = new Map<string, string[]>()

  get size(): number {
    return this.entries.size
  }

  add(entry: SceneEntry): void {
    this.entries.set(entry.id, entry)
    this.byObject.set(entry.mesh.id, entry.id)
    this.byObject.set(entry.edges.id, entry.id)
    entry.object.userData['surfaceId'] = entry.id
    entry.mesh.userData['surfaceId'] = entry.id
    entry.edges.userData['surfaceId'] = entry.id

    push(this.categories, entry.category, entry.id)
    if (entry.zoneId !== undefined) push(this.zones, entry.zoneId, entry.id)
  }

  get(id: string): SceneEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * The document id behind a raycast hit.
   *
   * Walks up the parent chain, because a hit reports the leaf it struck and a surface may
   * later grow child objects — a normal arrow, a selection outline. Stops at the scene root,
   * which is registered under no id.
   */
  idOfObject(object: Object3D | null | undefined): string | undefined {
    for (let o = object ?? null; o !== null; o = o.parent) {
      const id = this.byObject.get(o.id)
      if (id !== undefined) return id
    }
    return undefined
  }

  byCategory(category: SurfaceCategory): readonly string[] {
    return this.categories.get(category) ?? EMPTY
  }

  byZone(zoneId: string): readonly string[] {
    return this.zones.get(zoneId) ?? EMPTY
  }

  /** In insertion order, which is the model's document order. */
  values(): IterableIterator<SceneEntry> {
    return this.entries.values()
  }

  [Symbol.iterator](): IterableIterator<SceneEntry> {
    return this.entries.values()
  }

  /**
   * Release GPU resources and empty the registry.
   *
   * Geometries are per surface and are disposed here. Materials are shared across thousands
   * of surfaces and are owned by the material cache, so disposing them from here would free
   * a material still in use by the next scene.
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      disposeGeometry(entry.mesh)
      disposeGeometry(entry.edges)
      entry.object.parent?.remove(entry.object)
    }
    this.entries.clear()
    this.byObject.clear()
    this.categories.clear()
    this.zones.clear()
  }
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function disposeGeometry(object: Object3D): void {
  const geometry = (object as { geometry?: { dispose?: () => void } }).geometry
  geometry?.dispose?.()
}
