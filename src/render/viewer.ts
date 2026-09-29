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
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Float32BufferAttribute,
  GridHelper,
  Line,
  LineBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
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
import { applyColorBy, refreshSurfaces, type ColorBy } from './scene.js'
import type { SceneEntry } from './registry.js'
import type { Model, Vec3 } from '../model/index.js'
import type { ResolvedSurface } from '../geometry/index.js'

/** A ray in the model's own Z-up frame, ready for `geometry/drag.ts`. */
export interface ModelRay {
  origin: Vec3
  direction: Vec3
}

export type MarkerKind = 'vertex' | 'edge' | 'grid'

const HANDLE_COLOR = 0xff6d00
const HANDLE_ACTIVE_COLOR = 0xd50000
const MARKER_COLORS: Record<MarkerKind, number> = { vertex: 0xd500f9, edge: 0x00c853, grid: 0x2962ff }

function pointsOf(color: number, size: number): Points {
  const points = new Points(
    new BufferGeometry(),
    // Constant screen size, drawn over everything: a handle hidden behind the wall it belongs to
    // is a handle nobody can grab.
    new PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }),
  )
  points.renderOrder = 10
  points.frustumCulled = false
  points.raycast = () => {}
  return points
}

function setPoints(points: Points, vs: readonly Vec3[]): void {
  const flat: number[] = []
  for (const v of vs) flat.push(v.x, v.y, v.z)
  points.geometry.dispose()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(flat, 3))
  points.geometry = geometry
  points.visible = vs.length > 0
}

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

  // Edit handles live under the build root, so they share its Z-up → Y-up rotation and are
  // positioned in model coordinates like everything else.
  private readonly handles = pointsOf(HANDLE_COLOR, 11)
  private readonly activeHandle = pointsOf(HANDLE_ACTIVE_COLOR, 15)
  private readonly marker = pointsOf(MARKER_COLORS.vertex, 17)
  private handlePoints: Vec3[] = []
  private readonly sketch = new Line(
    new BufferGeometry(),
    new LineBasicMaterial({ color: HANDLE_ACTIVE_COLOR, depthTest: false, transparent: true }),
  )
  private readonly sketchPoints = pointsOf(HANDLE_COLOR, 9)

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

    // The ground plane at z = 0, for orientation and for drawing on. GridHelper lies in three's
    // XZ plane, which is the model's XY plane after the root's Z-up → Y-up rotation.
    const grid = new GridHelper(200, 200, 0xc8c8c4, 0xe2e2de)
    grid.renderOrder = -1
    this.scene.add(grid)

    this.sketch.renderOrder = 11
    this.sketch.frustumCulled = false
    this.sketch.raycast = () => {}

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
      build.root.add(this.handles, this.activeHandle, this.marker, this.sketch, this.sketchPoints)
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

  // -------------------------------------------------------------------------
  // Editing support — see geometry/drag.ts for what a drag actually does
  // -------------------------------------------------------------------------

  private ndc(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    return true
  }

  /** The ray under the pointer, in model (Z-up) coordinates. */
  rayAt(clientX: number, clientY: number): ModelRay | undefined {
    const root = this.build?.root
    if (!root || !this.ndc(clientX, clientY)) return undefined
    this.raycaster.setFromCamera(this.pointer, this.camera)
    root.updateMatrixWorld(true)
    const origin = root.worldToLocal(this.raycaster.ray.origin.clone())
    const inverse = root.getWorldQuaternion(new Quaternion()).invert()
    const direction = this.raycaster.ray.direction.clone().applyQuaternion(inverse)
    return {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
    }
  }

  /** A model point in client pixels, or undefined when it is behind the camera. */
  toClient(p: Vec3): { x: number; y: number } | undefined {
    const root = this.build?.root
    if (!root) return undefined
    root.updateMatrixWorld(true)
    const v = root.localToWorld(new Vector3(p.x, p.y, p.z)).project(this.camera)
    if (v.z > 1 || v.z < -1) return undefined
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    }
  }

  /** Show draggable vertex handles, optionally with one marked active. */
  setHandles(points: readonly Vec3[], active?: number): void {
    this.handlePoints = [...points]
    setPoints(this.handles, points)
    const a = active === undefined ? undefined : points[active]
    setPoints(this.activeHandle, a ? [a] : [])
    this.requestRender()
  }

  /** The handle within `radius` pixels of the pointer, nearest first. */
  pickHandle(clientX: number, clientY: number, radius = 10): number | undefined {
    let best: number | undefined
    let bestDist = radius
    this.handlePoints.forEach((p, i) => {
      const c = this.toClient(p)
      if (!c) return
      const d = Math.hypot(c.x - clientX, c.y - clientY)
      if (d <= bestDist) {
        bestDist = d
        best = i
      }
    })
    return best
  }

  /** Show where a drag snapped to, coloured by what it snapped to. Undefined hides it. */
  setMarker(point: Vec3 | undefined, kind: MarkerKind = 'vertex'): void {
    ;(this.marker.material as PointsMaterial).color.setHex(MARKER_COLORS[kind])
    setPoints(this.marker, point ? [point] : [])
    this.requestRender()
  }

  /**
   * Show an outline being drawn: `points` joined in order, closed back to the first when
   * `closed`. An empty list hides it.
   */
  setSketch(points: readonly Vec3[], closed = false): void {
    const ring = closed && points.length > 2 ? [...points, points[0]!] : points
    const flat: number[] = []
    for (const v of ring) flat.push(v.x, v.y, v.z)
    this.sketch.geometry.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(flat, 3))
    this.sketch.geometry = geometry
    this.sketch.visible = ring.length > 1
    setPoints(this.sketchPoints, points)
    this.requestRender()
  }

  /** Orbit and pan off while a handle is being dragged, so the drag does not also turn the camera. */
  setNavigationEnabled(enabled: boolean): void {
    this.controls.enabled = enabled
  }

  /**
   * Redraw some surfaces' geometry in place. Returns the ids it could not redraw, for which the
   * caller should rebuild the scene.
   */
  refresh(model: Model, resolved: ReadonlyMap<string, ResolvedSurface>, ids: Iterable<string>): string[] {
    if (!this.build) return [...ids]
    const missed = refreshSurfaces(this.build, model, resolved, ids)
    this.requestRender()
    return missed
  }

  /**
   * Swap in a rebuilt scene without moving the camera — for edits that change which surfaces
   * exist. `setBuild` alone would also be fine; this keeps the selection highlight.
   */
  replaceBuild(build: SceneBuild): void {
    const selected = this._selectedId
    this.setBuild(build)
    if (selected && build.registry.get(selected)) this.select(selected)
  }

  dispose(): void {
    this.disposed = true
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.observer?.disconnect()
    this.controls.removeEventListener('change', this.requestRender)
    this.controls.dispose()
    this.setBuild(undefined)
    this.sketch.geometry.dispose()
    ;(this.sketch.material as LineBasicMaterial).dispose()
    for (const p of [this.handles, this.activeHandle, this.marker, this.sketchPoints]) {
      p.geometry.dispose()
      ;(p.material as PointsMaterial).dispose()
    }
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
