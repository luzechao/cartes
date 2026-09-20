/**
 * Shared materials.
 *
 * A model with 8000 surfaces has, at most, a few dozen distinct colours — nine surface types
 * or a construction list a page long. Giving each surface its own material would multiply
 * draw calls and shader compiles by three orders of magnitude for no visual difference, so
 * materials are cached by colour and shared.
 *
 * The cache owns them, which is why `SceneRegistry.dispose` deliberately does not.
 */
import { Color, DoubleSide, MeshLambertMaterial } from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { GLAZED, type SurfaceCategory } from './palette.js'

export const EDGE_COLOR = 0x2b2b2b
export const EDGE_WIDTH = 1.5
export const SELECTION_COLOR = 0x00e5ff
export const SELECTION_WIDTH = 3.5
/** Windows and glass doors, so the room behind the glass stays legible. */
export const GLASS_OPACITY = 0.45

export class MaterialCache {
  private readonly meshes = new Map<string, MeshLambertMaterial>()
  private readonly lines = new Map<number, LineMaterial>()
  private width = 1
  private height = 1

  /**
   * `DoubleSide`, deliberately.
   *
   * EnergyPlus surfaces have a meaningful outward normal, so back-face culling would be
   * defensible and would make every wrong-facing surface obvious. It would also make the
   * inside of every zone invisible, and looking inside zones is most of what this tool is
   * for. Winding is still correct (`geometry/triangulate.ts`), so a "show surface
   * orientation" mode can flip this later without touching the geometry.
   */
  mesh(color: number, category: SurfaceCategory): MeshLambertMaterial {
    const glazed = GLAZED.has(category)
    const key = `${color}:${glazed ? 'g' : 'o'}`
    const existing = this.meshes.get(key)
    if (existing) return existing

    const material = new MeshLambertMaterial({
      color: new Color(color),
      side: DoubleSide,
      transparent: glazed,
      opacity: glazed ? GLASS_OPACITY : 1,
      depthWrite: !glazed,
    })
    this.meshes.set(key, material)
    return material
  }

  /**
   * Fat lines. `LineBasicMaterial` ignores `linewidth` on every platform that matters, which
   * is why three ships `LineMaterial` and why EPShape bundles it (docs/04-architecture.md
   * §Layer 4).
   *
   * `LineMaterial` needs the drawing-buffer size in pixels to convert a screen-space width
   * into clip space, so every cached instance is re-resolutioned on resize.
   */
  line(color: number = EDGE_COLOR, width: number = EDGE_WIDTH): LineMaterial {
    const key = (color << 8) | Math.round(width * 10)
    const existing = this.lines.get(key)
    if (existing) return existing

    const material = new LineMaterial({
      color: new Color(color).getHex(),
      linewidth: width,
      worldUnits: false,
    })
    material.resolution.set(this.width, this.height)
    this.lines.set(key, material)
    return material
  }

  selectionLine(color: number = SELECTION_COLOR): LineMaterial {
    return this.line(color, SELECTION_WIDTH)
  }

  setResolution(width: number, height: number): void {
    this.width = width
    this.height = height
    for (const material of this.lines.values()) material.resolution.set(width, height)
  }

  dispose(): void {
    for (const material of this.meshes.values()) material.dispose()
    for (const material of this.lines.values()) material.dispose()
    this.meshes.clear()
    this.lines.clear()
  }
}
