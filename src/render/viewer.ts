/**
 * The viewer — renderer, camera, controls, picking.
 *
 * Everything in this file needs a GPU and a DOM, and nothing else in `render/` does. That is
 * the whole reason it is one file: `scene.ts` builds a graph that can be asserted in Node,
 * and this turns it into pixels in a browser. Keep the boundary — the moment scene structure
 * starts depending on `WebGLRenderer`, the scene layer stops being testable.
 */
import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Object3D,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneBuild } from './scene.js'
import { applyColorBy, type ColorBy } from './scene.js'
import type { SceneEntry } from './registry.js'

export interface HoverInfo {
  id: string
  name: string
  className: string
  construction: string
  zone: string
  /** Where on the surface the ray struck, in world (Y-up) space — for a tooltip anchor. */
  point: Vector3
}

export interface ViewerOptions {
  background: number
  /** Multiplies the fitted distance, so `fit()` leaves margin around the model. */
  fitMargin: number
}

const DEFAULTS: ViewerOptions = {
  background: 0xf2f2f0,
  fitMargin: 1.35,
}

export class Viewer {
  readonly scene = new Scene()
  readonly camera: PerspectiveCamera
  readonly renderer: WebGLRenderer
  readonly controls: OrbitControls

  private build: SceneBuild | undefined
  private readonly options: ViewerOptions
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly observer: ResizeObserver | undefined
  private frame = 0
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: Partial<ViewerOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.scene.background = new Color(this.options.background)

    // WebGL2, not WebGPU: universal support today, and nothing here needs compute
    // (docs/04-architecture.md §Layer 4).
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2))

    this.camera = new PerspectiveCamera(50, 1, 0.1, 10_000)
    this.camera.position.set(30, 25, 30)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    // Orbit and pan, no keyboard-modifier gymnastics: middle drag or two fingers to pan.
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', this.requestRender)

    this.scene.add(new HemisphereLight(0xffffff, 0x606070, 2.2))
    const sun = new DirectionalLight(0xffffff, 1.1)
    sun.position.set(0.6, 1, 0.4)
    this.scene.add(sun)

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(canvas)
    }
    this.resize()
  }

  /**
   * Render on demand — docs/04-architecture.md §Layer 4.
   *
   * A static building at 60 fps is 60 identical frames a second, a hot laptop and a flat
   * battery for nothing. Frames are drawn when something changes: the camera moves, the
   * selection changes, geometry is rebuilt. Damped controls keep requesting until they settle,
   * which is why the request coalesces through `requestAnimationFrame` rather than drawing
   * straight away.
   */
  readonly requestRender = (): void => {
    if (this.disposed || this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.disposed) return
      if (this.controls.enableDamping && this.controls.update()) this.requestRender()
      this.renderer.render(this.scene, this.camera)
    })
  }

  private _selectedId: string | undefined

  get selectedId(): string | undefined {
    return this._selectedId
  }

  /** Swap in a new scene build, disposing whatever it replaces. */
  setBuild(build: SceneBuild | undefined): void {
    if (this.build) {
      this.scene.remove(this.build.root)
      this.build.registry.dispose()
      this.build.materials.dispose()
    }
    this._selectedId = undefined
    this.build = build
    if (build) {
      this.scene.add(build.root)
      const size = this.renderer.getDrawingBufferSize(new Vector2())
      build.materials.setResolution(size.x, size.y)
    }
    this.requestRender()
  }

  /** Highlight an object's outline in the scene. */
  select(id: string | undefined): void {
    if (this._selectedId === id) return
    if (this.build) {
      if (this._selectedId) {
        const prev = this.build.registry.get(this._selectedId)
        if (prev) {
          ;(prev.edges as unknown as { material: unknown }).material = this.build.materials.line()
        }
      }
      if (id) {
        const next = this.build.registry.get(id)
        if (next) {
          ;(next.edges as unknown as { material: unknown }).material = this.build.materials.selectionLine()
        }
      }
    }
    this._selectedId = id
    this.requestRender()
  }

  /** Center and frame the camera on a specific object. */
  focus(id: string): void {
    if (!this.build) return
    const entry = this.build.registry.get(id)
    if (!entry) return
    const box = new Box3().setFromObject(entry.mesh)
    if (box.isEmpty()) return
    const sphere = box.getBoundingSphere(new Sphere())
    if (!(sphere.radius > 0)) return

    const fov = (this.camera.fov * Math.PI) / 180
    const distance = Math.max(sphere.radius / Math.sin(fov / 2), 2) * this.options.fitMargin
    const offset = this.camera.position.clone().sub(this.controls.target).normalize()
    if (offset.lengthSq() < 0.1) offset.set(1, 0.8, 1).normalize()

    this.camera.position.copy(sphere.center).addScaledVector(offset, distance)
    this.controls.target.copy(sphere.center)
    this.controls.update()
    this.requestRender()
  }

  setColorBy(colorBy: ColorBy): void {
    if (!this.build) return
    applyColorBy(this.build.registry, this.build.materials, colorBy)
    this.requestRender()
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1
    const height = this.canvas.clientHeight || 1
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    this.build?.materials.setResolution(size.x, size.y)
    this.requestRender()
  }

  /**
   * Frame the whole model.
   *
   * Fits the bounding *sphere*, not the box, so the framing does not change as the model is
   * orbited — fitting the box means the building appears to breathe as you rotate it.
   */
  fit(): void {
    const root = this.build?.root
    if (!root) return
    const box = new Box3().setFromObject(root)
    if (box.isEmpty()) return
    const sphere = box.getBoundingSphere(new Sphere())
    if (!(sphere.radius > 0)) return

    const fov = (this.camera.fov * Math.PI) / 180
    const vertical = sphere.radius / Math.sin(fov / 2)
    const horizontal = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * this.camera.aspect))
    const distance = Math.max(vertical, horizontal) * this.options.fitMargin

    const direction = new Vector3(1, 0.8, 1).normalize()
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
    this.camera.near = Math.max(distance / 1000, 0.01)
    this.camera.far = distance * 10
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(sphere.center)
    this.controls.update()
    this.requestRender()
  }

  /**
   * What is under the pointer, with the metadata the hover readout wants: name,
   * construction, zone.
   *
   * Raycasts against meshes only. Outlines are excluded in `scene.ts`, and hitting the
   * *nearest* surface is what makes the readout trustworthy — with `DoubleSide` materials a
   * ray through a building crosses several walls, and the first is the one being pointed at.
   */
  pick(clientX: number, clientY: number): HoverInfo | undefined {
    if (!this.build) return undefined
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const targets: Object3D[] = []
    for (const entry of this.build.registry) if (entry.object.visible) targets.push(entry.mesh)

    const hits: Intersection[] = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      const id = this.build.registry.idOfObject(hit.object)
      const entry = id === undefined ? undefined : this.build.registry.get(id)
      if (entry) return hoverInfo(entry, hit.point.clone())
    }
    return undefined
  }

  dispose(): void {
    this.disposed = true
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.observer?.disconnect()
    this.controls.removeEventListener('change', this.requestRender)
    this.controls.dispose()
    this.setBuild(undefined)
    this.renderer.dispose()
  }
}

export function hoverInfo(entry: SceneEntry, point: Vector3): HoverInfo {
  return {
    id: entry.id,
    name: entry.name,
    className: entry.className,
    // Shading carries no construction and belongs to no zone; an em dash reads better than a
    // blank cell, and better than pretending there is a value.
    construction: entry.constructionName === '' ? '—' : entry.constructionName,
    zone: entry.zoneName ?? '—',
    point,
  }
}
