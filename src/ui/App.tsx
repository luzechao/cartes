/**
 * The shell — Phase 5 of docs/05-implementation-plan.md.
 *
 * Provides:
 * - Object Tree grouped by thermal zone
 * - Declarative IDD Property Inspector
 * - Headless Validation drawer
 * - Live Unified Diff & Raw IDF Viewer
 * - On-demand 3D rendering stage with interactive selection
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseIdf, emitIdf, type IdfDocument } from '../parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  EditHistory,
  LATEST_IDD_VERSION,
  newModelSource,
  setFieldValue,
  revertObject,
  revertAll,
  getDirtyObjects,
  planSurfaceDeletion,
  type Model,
} from '../model/index.js'
import {
  applyMatchProposals,
  applyTier3Conversion,
  applyZoneTranslation,
  buildSnapIndex,
  extrudeZone,
  placeOpening,
  snapPoint,
  suggestConstruction,
  suggestInteriorConstructions,
  surfaceExtent,
  DEFAULT_SNAP_SETTINGS,
  deleteVertex,
  DragSession,
  insertVertexWorld,
  intersectRayPlane,
  nearestEdge,
  planDrag,
  planeOfSurface,
  planTier3Conversion,
  planZoneTranslation,
  proposeMatches,
  resolveModel,
  resolveSurface,
  transformContext,
  validateModel,
  type DragMode,
  type MatchProposal,
  type SnapIndex,
  type ResolvedSurface,
  type SnapSettings,
  type TwinOutcome,
  type ValidationIssue,
  type ValidationReport,
} from '../geometry/index.js'
import { buildScene, computeStoreys, Viewer, type ColorBy, type HoverInfo, type StoreyDisplay } from '../render/index.js'
import { ObjectTree } from './ObjectTree.js'
import { Inspector } from './Inspector.js'
import { DiffPanel } from './DiffPanel.js'
import { MatchPanel } from './MatchPanel.js'
import { useDialog } from './Dialog.js'
import { decodeViewState, encodeViewState, type DisplayState } from './viewState.js'

interface LoadedFile {
  name: string
  doc: IdfDocument
  model: Model
  resolved: Map<string, ResolvedSurface>
  validation: ValidationReport
  originalSource: string
  /** Parse + model + resolve + validate, in milliseconds. */
  ms: number
  /** Undo/redo over this document. See model/history.ts. */
  history: EditHistory
}

type EditMode = 'off' | DragMode | 'draw'

/** A zone outline being drawn on a horizontal plane. */
interface Sketch {
  z: number
  points: Array<{ x: number; y: number; z: number }>
  index: SnapIndex
}

interface ActiveDrag {
  session: DragSession
  pointerId: number
  handle: number
  /** Geometry as of the latest drag frame, for redrawing handles. */
  resolved: Map<string, ResolvedSurface>
}

/** Pixels within which a double-click counts as "on" an edge. */
const EDGE_PICK_PX = 12

function twinNotice(twin: TwinOutcome | undefined): string | undefined {
  if (!twin) return undefined
  return twin.mirrored
    ? `Also applied to interzone twin ${twin.name}.`
    : `Twin ${twin.name} was not changed: ${twin.reason ?? 'unknown reason'}. Validation will flag the pair.`
}

/**
 * Screen distance from a pointer to a surface's outline, in pixels.
 *
 * Handles and the selection outline are drawn over whatever is in front of them, so in edit
 * mode a click on them must count as a click on the selected surface — not on the wall that
 * happens to be nearer the camera.
 */
function outlineDistancePx(
  viewer: Viewer,
  surface: ResolvedSurface,
  clientX: number,
  clientY: number,
): number {
  const pts = surface.worldVertices.map((v) => viewer.toClient(v))
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((clientX - a.x) * dx + (clientY - a.y) * dy) / len))
    best = Math.min(best, Math.hypot(clientX - (a.x + dx * t), clientY - (a.y + dy * t)))
  }
  return best
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

interface BuildStats {
  drawn: number
  /** Surfaces with too little geometry to draw. Never silently dropped. */
  skipped: number
}

type RightPanelTab = 'inspector' | 'validation' | 'matching'
type ValidationFilter = 'all' | 'error' | 'warning'

export function App(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)

  const [loaded, setLoaded] = useState<LoadedFile | undefined>(undefined)
  const [stats, setStats] = useState<BuildStats | undefined>(undefined)
  const [colorBy, setColorBy] = useState<ColorBy>('type')
  const [hover, setHover] = useState<HoverInfo | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const [showTree, setShowTree] = useState(true)
  const [showRightPanel, setShowRightPanel] = useState(true)
  const [rightTab, setRightTab] = useState<RightPanelTab>('inspector')
  const [validationFilter, setValidationFilter] = useState<ValidationFilter>('all')
  const [showDiff, setShowDiff] = useState(false)

  const [error, setError] = useState<string | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  const [editMode, setEditMode] = useState<EditMode>('off')
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP_SETTINGS)
  const [activeHandle, setActiveHandle] = useState<number | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [display, setDisplay] = useState<DisplayState>({ mode: 'stacked' })
  const { ask, element: dialog } = useDialog()

  // Pointer and keyboard handlers outlive a render; they read the current state through these.
  const loadedRef = useRef<LoadedFile | undefined>(undefined)
  const selectedRef = useRef<string | undefined>(undefined)
  const editModeRef = useRef<EditMode>('off')
  const activeHandleRef = useRef<number | undefined>(undefined)
  const dragRef = useRef<ActiveDrag | undefined>(undefined)
  const sketchRef = useRef<Sketch | undefined>(undefined)
  // Read once, at page load: the view a shared link asks for.
  const sharedViewRef = useRef<ReturnType<typeof decodeViewState> | undefined>(decodeViewState(globalThis.location?.hash ?? ''))
  const colorByRef = useRef<ColorBy>('type')
  const snapRef = useRef<SnapSettings>(DEFAULT_SNAP_SETTINGS)
  loadedRef.current = loaded
  colorByRef.current = colorBy
  snapRef.current = snap
  selectedRef.current = selectedId
  editModeRef.current = editMode
  activeHandleRef.current = activeHandle

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewer = new Viewer(canvas)
    viewerRef.current = viewer
    // For end-to-end tests: project model points to the screen. Development builds only.
    if (import.meta.env.DEV) (globalThis as { __cartesViewer?: Viewer }).__cartesViewer = viewer
    return () => {
      viewerRef.current = null
      viewer.dispose()
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (!loaded) {
      viewer.setBuild(undefined)
      setStats(undefined)
      return
    }
    // A shared link's view, if the page was opened with one — consumed by the first file opened,
    // never again: after that the fragment is this session's own, rewritten as the view changes.
    const shared = sharedViewRef.current ?? {}
    sharedViewRef.current = undefined
    const colorMode = shared.colorBy ?? colorBy
    const build = buildScene(loaded.model, loaded.resolved, { colorBy: colorMode })
    viewer.setBuild(build)
    viewer.fit()
    if (shared.camera) viewer.setCamera(shared.camera)
    if (shared.colorBy) setColorBy(shared.colorBy)
    setDisplay(shared.display ?? { mode: 'stacked' })
    setStats({ drawn: build.registry.size, skipped: build.skipped.length })
    setHover(undefined)
    const sel = shared.selected
      ? [...loaded.model.surfaces.values()].find((x) => x.name === shared.selected)?.id
      : undefined
    setSelectedId(sel)
    viewer.select(sel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.originalSource])

  const storeys = useMemo(() => (loaded ? computeStoreys(loaded.model, loaded.resolved) : undefined), [loaded])

  // Storey display follows the model: after an edit rebuilds the scene, it is reapplied.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !storeys) return
    const d: StoreyDisplay =
      display.mode === 'solo' && display.storey >= storeys.storeys.length ? { mode: 'stacked' } : display
    viewer.setStoreyDisplay(storeys, d)
  }, [storeys, display, stats])

  // Keep the URL fragment describing the current view, so the address bar is always a share link.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !loaded) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const write = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const selected = selectedRef.current ? loadedRef.current?.doc.objects.get(selectedRef.current)?.fields[0]?.value : undefined
        const hash = encodeViewState({
          camera: viewer.getCamera(),
          ...(selected ? { selected } : {}),
          colorBy: colorByRef.current,
          display,
        })
        globalThis.history?.replaceState(null, '', `#${hash}`)
      }, 250)
    }
    write()
    const off = viewer.onCameraChange(write)
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [loaded, selectedId, colorBy, display])

  useEffect(() => {
    viewerRef.current?.setColorBy(colorBy)
  }, [colorBy])

  const load = useCallback((name: string, text: string) => {
    try {
      setError(undefined)
      const started = performance.now()
      const doc = parseIdf(text)
      const model = buildModel(doc)
      const resolved = resolveModel(model)
      const validation = validateModel(model, resolved, doc)
      loadedRef.current?.history.detach()
      sketchRef.current = undefined
      setLoaded({
        name,
        doc,
        model,
        resolved,
        validation,
        originalSource: text,
        ms: performance.now() - started,
        history: new EditHistory(doc),
      })
      setActiveHandle(undefined)
      setNotice(undefined)
      setSelectedId(undefined)
      setShowRightPanel(true)
      setRightTab(validation.issues.length > 0 ? 'validation' : 'inspector')
    } catch (cause) {
      setLoaded(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const open = useCallback(
    async (file: File) => {
      load(file.name, await file.text())
    },
    [load],
  )

  /** Start from the authoring template, straight into drawing a zone. */
  const newModel = useCallback(() => {
    load('untitled.idf', newModelSource(LATEST_IDD_VERSION))
    setEditMode('draw')
    setSnap((s) => (s.grid ? s : { ...s, grid: true }))
    setNotice('New model. Click on the ground to place the corners of a zone; double-click or press Enter to finish.')
  }, [load])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files[0]
      if (file) void open(file)
    },
    [open],
  )

  /**
   * Re-derive everything downstream of the Document after an edit.
   *
   * `rebuild` replaces the Model and the scene outright — for anything that changes which
   * objects exist, or that the in-place Model sync does not cover (undo and redo, deletion,
   * inspector edits to zones or to GlobalGeometryRules). Otherwise only the named surfaces are
   * redrawn, which is what keeps a drag or a vertex insertion cheap on a large file.
   */
  const commit = useCallback((opts: { rebuild?: boolean; refresh?: Iterable<string> } = {}) => {
    const current = loadedRef.current
    if (!current) return
    const model = opts.rebuild ? buildModel(current.doc) : current.model
    const resolved = resolveModel(model)
    const validation = validateModel(model, resolved, current.doc)
    const next: LoadedFile = { ...current, model, resolved, validation }
    loadedRef.current = next
    setLoaded(next)

    const viewer = viewerRef.current
    if (!viewer) return
    let rebuild = opts.rebuild === true
    if (!rebuild && opts.refresh) rebuild = viewer.refresh(model, resolved, opts.refresh).length > 0
    if (rebuild) {
      const build = buildScene(model, resolved, { colorBy: colorByRef.current })
      viewer.replaceBuild(build)
      setStats({ drawn: build.registry.size, skipped: build.skipped.length })
    }
    const selected = selectedRef.current
    if (selected && !current.doc.objects.has(selected)) {
      setSelectedId(undefined)
      viewer.select(undefined)
      setActiveHandle(undefined)
    }
  }, [])

  const endDrag = useCallback(
    (event?: React.PointerEvent) => {
      const drag = dragRef.current
      const current = loadedRef.current
      if (!drag || !current) return
      dragRef.current = undefined
      current.history.end()
      const viewer = viewerRef.current
      viewer?.setNavigationEnabled(true)
      viewer?.setMarker(undefined)
      if (event && (event.target as Element).hasPointerCapture?.(drag.pointerId)) {
        ;(event.target as Element).releasePointerCapture(drag.pointerId)
      }
      commit({ refresh: drag.session.surfaceIds })
    },
    [commit],
  )

  /**
   * Grab a handle — in the capture phase, so it runs before OrbitControls' own listener on the
   * canvas and can switch the camera off before the camera starts turning.
   */
  const onPointerDownCapture = useCallback((event: React.PointerEvent) => {
    const current = loadedRef.current
    const mode = editModeRef.current
    const selected = selectedRef.current
    const viewer = viewerRef.current
    if (!current || !viewer || mode === 'off' || mode === 'draw' || !selected || event.button !== 0) return

    const handle = viewer.pickHandle(event.clientX, event.clientY)
    if (handle === undefined) return
    setActiveHandle(handle)

    const start = planDrag(current.model, current.resolved, selected, handle, mode)
    if (!start) return
    if (start.refused) {
      setNotice(`Cannot drag this corner: ${start.refused}.`)
      return
    }
    const split = start.cornerPlan?.splitPairs ?? []
    setNotice(
      split.length > 0
        ? `Moving one side only of ${split.map((p) => `${p.surfaceName} / ${p.twinName}`).join(', ')} — ` +
            'those twins are drawn offset and cannot be matched by position.'
        : undefined,
    )

    current.history.begin(mode === 'corner' ? 'Move corner' : 'Move vertex')
    dragRef.current = {
      session: new DragSession(current.doc, current.model, current.resolved, start, snapRef.current),
      pointerId: event.pointerId,
      handle,
      resolved: new Map(current.resolved),
    }
    viewer.setNavigationEnabled(false)
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }, [])

  /** Where the pointer meets the sketch plane, snapped to grid and to existing corners. */
  const sketchPoint = useCallback((clientX: number, clientY: number) => {
    const sketch = sketchRef.current
    const ray = viewerRef.current?.rayAt(clientX, clientY)
    if (!sketch || !ray) return undefined
    const plane = { normal: { x: 0, y: 0, z: 1 }, constant: sketch.z }
    const hit = intersectRayPlane(ray, plane)
    return hit ? snapPoint(hit, sketch.index, snapRef.current, plane) : undefined
  }, [])

  const showSketch = useCallback((preview?: { x: number; y: number; z: number }) => {
    const sketch = sketchRef.current
    const viewer = viewerRef.current
    if (!viewer) return
    const pts = sketch ? [...sketch.points, ...(preview ? [preview] : [])] : []
    viewer.setSketch(pts, pts.length > 2)
  }, [])

  const cancelSketch = useCallback(() => {
    if (sketchRef.current) sketchRef.current.points = []
    showSketch()
    viewerRef.current?.setMarker(undefined)
  }, [showSketch])

  /** Turn the drawn outline into a zone: name and height asked for, constructions from the file. */
  const finishSketch = useCallback(async () => {
    const current = loadedRef.current
    const sketch = sketchRef.current
    if (!current || !sketch) return
    if (sketch.points.length < 3) {
      setNotice('A zone needs at least three corners.')
      return
    }
    const { doc, model } = current
    const constructions = {
      wall: suggestConstruction(doc, model, 'exterior-wall'),
      floor: suggestConstruction(doc, model, 'ground-floor'),
      roof: suggestConstruction(doc, model, 'roof'),
    }
    const missing = Object.entries(constructions).filter(([, c]) => !c).map(([k]) => k)
    if (missing.length > 0) {
      setNotice(`No construction found for the new zone's ${missing.join(', ')} — add one to the file first, or start from New.`)
      return
    }
    let n = model.zones.size + 1
    while ([...model.zones.values()].some((z) => z.name.toLowerCase() === `zone ${n}`)) n++
    const answer = await ask({
      title: 'New zone',
      message: [
        `${sketch.points.length} corners${sketch.z !== 0 ? `, floor at ${+sketch.z.toFixed(3)} m` : ' on the ground'}.`,
        `Walls ${constructions.wall}, floor ${constructions.floor}, roof ${constructions.roof} — the file's own, where it has them.`,
      ],
      fields: [
        { key: 'name', label: 'Name', value: `Zone ${n}` },
        { key: 'height', label: 'Height (m)', value: '3', kind: 'number' },
      ],
      confirmLabel: 'Create zone',
    })
    if (!answer) return
    const name = answer['name']!
    const result = extrudeZone(doc, model, {
      zoneName: name,
      footprint: sketch.points,
      baseZ: sketch.z,
      height: Number(answer['height']),
      constructions: constructions as { wall: string; floor: string; roof: string },
    })
    if (result.refused) {
      setNotice(`Cannot create the zone: ${result.refused}.`)
      return
    }
    cancelSketch()
    commit({ rebuild: true })
    const after = loadedRef.current!
    const created = new Set(result.created)
    const pairs = proposeMatches(after.doc, after.model, after.resolved, undefined, {
      interiorConstructions: suggestInteriorConstructions(after.doc, after.model),
    }).proposals.filter((p) => created.has(p.a) || created.has(p.b))
    if (pairs.length > 0) {
      setRightTab('matching')
      setShowRightPanel(true)
    }
    setNotice(
      `Created zone '${name}' with ${result.created.length - 1} surfaces.` +
        (pairs.length > 0
          ? ` ${pairs.length} of its surfaces meet a neighbour — review the proposed pairs under Matching.`
          : ' Draw another, or select a wall to add windows.'),
    )
  }, [ask, cancelSketch, commit])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (dragRef.current) return
    pointerDownRef.current = { x: event.clientX, y: event.clientY }
  }, [])

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (dragRef.current) {
        endDrag(event)
        return
      }
      const down = pointerDownRef.current
      if (!down) return
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) {
        if (editModeRef.current === 'draw') {
          const sketch = sketchRef.current
          const p = sketchPoint(event.clientX, event.clientY)
          if (!sketch || !p) return
          const first = sketch.points[0]
          const screenFirst = first && viewerRef.current?.toClient(first)
          if (
            sketch.points.length >= 3 &&
            screenFirst &&
            Math.hypot(screenFirst.x - event.clientX, screenFirst.y - event.clientY) <= EDGE_PICK_PX
          ) {
            finishSketch()
            return
          }
          sketch.points.push(p.point)
          showSketch()
          return
        }
        const viewer = viewerRef.current
        const selected = selectedRef.current
        const outline = selected ? loadedRef.current?.resolved.get(selected) : undefined
        if (
          editModeRef.current !== 'off' &&
          viewer &&
          outline &&
          outlineDistancePx(viewer, outline, event.clientX, event.clientY) <= EDGE_PICK_PX
        ) {
          return
        }
        const hit = viewer?.pick(event.clientX, event.clientY)
        if (hit?.id !== selectedRef.current) setActiveHandle(undefined)
        setSelectedId(hit?.id)
        viewerRef.current?.select(hit?.id)
        if (hit?.id) {
          setRightTab('inspector')
          setShowRightPanel(true)
        }
      }
    },
    [endDrag, finishSketch, showSketch, sketchPoint],
  )

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    const current = loadedRef.current
    const viewer = viewerRef.current
    if (editModeRef.current === 'draw' && viewer && sketchRef.current) {
      const p = sketchPoint(event.clientX, event.clientY)
      showSketch(p?.point)
      viewer.setMarker(p && p.kind !== 'none' ? p.point : undefined, p && p.kind !== 'none' ? p.kind : undefined)
      return
    }
    if (!drag || !current || !viewer) {
      setHover(viewer?.pick(event.clientX, event.clientY))
      return
    }
    const ray = viewer.rayAt(event.clientX, event.clientY)
    const update = ray && drag.session.updateFromRay(ray)
    if (!update) return

    const ctx = transformContext(current.model)
    for (const id of drag.session.surfaceIds) {
      const surface = current.model.surfaces.get(id)
      if (surface) drag.resolved.set(id, resolveSurface(current.model, surface, ctx))
    }
    viewer.refresh(current.model, drag.resolved, drag.session.surfaceIds)
    const selected = selectedRef.current
    viewer.setHandles((selected && drag.resolved.get(selected)?.worldVertices) || [], drag.handle)
    viewer.setMarker(update.snap.kind === 'none' ? undefined : update.point, update.snap.kind === 'none' ? undefined : update.snap.kind)
  }, [showSketch, sketchPoint])

  /** Double-click on an edge of the selected surface: split it there. */
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const current = loadedRef.current
      const viewer = viewerRef.current
      const selected = selectedRef.current
      if (editModeRef.current === 'draw') {
        finishSketch()
        return
      }
      if (!current || !viewer || editModeRef.current !== 'vertex' || !selected) return
      const r = current.resolved.get(selected)
      const plane = r && planeOfSurface(r)
      const ray = viewer.rayAt(event.clientX, event.clientY)
      const onPlane = plane && ray && intersectRayPlane(ray, plane)
      const hit = r && onPlane && nearestEdge(r, onPlane)
      const screen = hit && viewer.toClient(hit.point)
      if (!hit || !screen || Math.hypot(screen.x - event.clientX, screen.y - event.clientY) > EDGE_PICK_PX) return

      const result = insertVertexWorld(current.doc, current.model, selected, hit.edgeIndex, hit.point)
      if (!result.changed) {
        setNotice(`Cannot add a vertex: ${result.refused}.`)
        return
      }
      setNotice(twinNotice(result.twin) ?? 'Vertex added — drag it to reshape the surface.')
      commit({ refresh: result.dirtied })
      const after = loadedRef.current?.resolved.get(selected)?.worldVertices ?? []
      const index = after.findIndex(
        (v) => Math.hypot(v.x - hit.point.x, v.y - hit.point.y, v.z - hit.point.z) < 1e-6,
      )
      setActiveHandle(index === -1 ? undefined : index)
    },
    [commit, finishSketch],
  )

  const undo = useCallback(() => {
    const current = loadedRef.current
    if (!current || dragRef.current) return
    const step = current.history.undo()
    if (!step) return
    setNotice(`Undid: ${step.label}.`)
    setActiveHandle(undefined)
    commit({ rebuild: true })
  }, [commit])

  const redo = useCallback(() => {
    const current = loadedRef.current
    if (!current || dragRef.current) return
    const step = current.history.redo()
    if (!step) return
    setNotice(`Redid: ${step.label}.`)
    setActiveHandle(undefined)
    commit({ rebuild: true })
  }, [commit])

  /** Delete the active vertex, or — with no vertex active — the selected surface. */
  const deleteSelection = useCallback(async () => {
    const current = loadedRef.current
    const selected = selectedRef.current
    if (!current || !selected || dragRef.current) return
    const { doc, model } = current

    const handle = activeHandleRef.current
    if (handle !== undefined) {
      const result = deleteVertex(doc, model, selected, handle)
      if (!result.changed) {
        setNotice(`Cannot delete the vertex: ${result.refused}.`)
        return
      }
      setNotice(twinNotice(result.twin) ?? 'Vertex deleted.')
      setActiveHandle(undefined)
      commit({ refresh: result.dirtied })
      return
    }

    const plan = planSurfaceDeletion(doc, model, buildReferenceIndex(doc, model.version), selected)
    if (!plan) return
    const lines: string[] = []
    if (plan.cascade.length > 0) {
      lines.push('Also deleted, because they cannot exist without it:')
      for (const c of plan.cascade) lines.push(`• ${c.className} '${c.name}'`)
    }
    const others = [...plan.otherReferences, ...plan.undeclaredMentions]
    if (others.length > 0) {
      lines.push(`${others.length} other field(s) name it and will be left dangling:`)
      for (const r of others.slice(0, 8)) lines.push(`• ${doc.objects.get(r.fromId)?.className ?? r.fromClassKey}: ${r.fieldName}`)
    }
    if (plan.twins.length > 0) {
      lines.push(
        `${plan.twins.map((t) => `'${t.name}'`).join(', ')} name${plan.twins.length === 1 ? 's' : ''} this surface as ` +
          'its interzone twin. EnergyPlus will not run while that reference dangles.',
      )
    }
    const answer = await ask({
      title: `Delete ${plan.className} '${plan.surfaceName}'?`,
      message: lines,
      fields:
        plan.twins.length > 0
          ? [{ key: 'adiabatic', label: 'Set the twin to Adiabatic', value: 'false', kind: 'checkbox', hint: 'otherwise it is left for you to fix' }]
          : [],
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!answer) return
    const twins: 'leave' | 'adiabatic' = answer['adiabatic'] === 'true' ? 'adiabatic' : 'leave'
    const result = applySurfaceDeletion(doc, model, plan, { twins })
    setNotice(
      `Deleted ${result.deleted.length} object${result.deleted.length === 1 ? '' : 's'}` +
        (result.repairedTwins.length > 0 ? `; ${result.repairedTwins.length} twin set to Adiabatic.` : '.'),
    )
    commit({ rebuild: true })
  }, [ask, commit])

  /** Move the selected surface's whole zone by a typed offset. */
  const moveZone = useCallback(async () => {
    const current = loadedRef.current
    const selected = selectedRef.current
    if (!current || !selected) return
    const zoneId = current.model.zoneOf.get(selected)
    const zone = zoneId === undefined ? undefined : current.model.zones.get(zoneId)
    if (!zone || !zoneId) {
      setNotice('The selected surface belongs to no zone.')
      return
    }
    const answer = await ask({
      title: `Move zone '${zone.name}'`,
      message: ['By an offset in metres, along the world axes.'],
      fields: [
        { key: 'x', label: 'dx', value: '0', kind: 'number' },
        { key: 'y', label: 'dy', value: '0', kind: 'number' },
        { key: 'z', label: 'dz', value: '0', kind: 'number' },
      ],
      confirmLabel: 'Move',
    })
    if (!answer) return
    const [x, y, z] = ['x', 'y', 'z'].map((k) => Number(answer[k])) as [number, number, number]
    if (![x, y, z].every(Number.isFinite)) {
      setNotice('Enter a number for each of dx, dy and dz.')
      return
    }
    const plan = planZoneTranslation(current.doc, current.model, zoneId, { x, y, z })
    if (!plan) return
    const warnings: string[] = []
    if (plan.splitPairs.length > 0) {
      warnings.push(`${plan.splitPairs.length} interzone pair(s) will no longer coincide: ` +
        plan.splitPairs.map((p) => `${p.surfaceName} / ${p.twinName}`).join(', '))
    }
    if (plan.leftBehind.length > 0) {
      warnings.push(`${plan.leftBehind.length} object(s) will be left behind: ` +
        plan.leftBehind.map((l) => `${l.name} (${l.reason})`).join('; '))
    }
    if (warnings.length > 0 && !(await ask({ title: 'Move the zone anyway?', message: warnings, confirmLabel: 'Move' }))) return
    const result = applyZoneTranslation(current.doc, current.model, plan)
    setNotice(`Moved zone '${zone.name}' — ${result.dirtied.length} object${result.dirtied.length === 1 ? '' : 's'} changed.`)
    commit({ rebuild: true })
  }, [ask, commit])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return
      if ((event.target as HTMLElement | null)?.closest?.('.dialog-backdrop')) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        event.preventDefault()
        redo()
      } else if (editModeRef.current === 'draw' && sketchRef.current) {
        if (key === 'enter') {
          event.preventDefault()
          finishSketch()
        } else if (key === 'escape') {
          cancelSketch()
        } else if (key === 'backspace' || key === 'delete') {
          event.preventDefault()
          sketchRef.current.points.pop()
          showSketch()
        }
      } else if ((key === 'delete' || key === 'backspace') && editModeRef.current !== 'off') {
        event.preventDefault()
        deleteSelection()
      } else if (key === 'escape') {
        setActiveHandle(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelection, finishSketch, cancelSketch, showSketch])

  // Entering draw mode fixes the sketch plane: on top of a selected roof or floor, else the ground.
  useEffect(() => {
    const viewer = viewerRef.current
    if (editMode !== 'draw' || !loaded) {
      if (sketchRef.current) {
        sketchRef.current = undefined
        viewer?.setSketch([])
        viewer?.setMarker(undefined)
      }
      return
    }
    if (sketchRef.current) {
      // Geometry changed under an open sketch: keep the corners, refresh what they snap to.
      sketchRef.current.index = buildSnapIndex(loaded.resolved)
      return
    }
    const sel = selectedId ? loaded.resolved.get(selectedId) : undefined
    const z = sel && Math.abs(sel.normal.z) > 0.999 ? sel.centroid.z : 0
    sketchRef.current = { z, points: [], index: buildSnapIndex(loaded.resolved) }
  }, [editMode, loaded, selectedId])

  // Vertex handles follow the selection in edit mode.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || dragRef.current) return
    const r = editMode !== 'off' && editMode !== 'draw' && selectedId ? loaded?.resolved.get(selectedId) : undefined
    viewer.setHandles(r?.worldVertices ?? [], activeHandle)
  }, [loaded, selectedId, editMode, activeHandle])

  const selectObject = useCallback((id: string) => {
    setSelectedId(id)
    viewerRef.current?.select(id)
    setRightTab('inspector')
    setShowRightPanel(true)
  }, [])

  const focusObject = useCallback((id: string) => {
    viewerRef.current?.focus(id)
  }, [])

  const selectIssue = useCallback((issue: ValidationIssue) => {
    setSelectedId(issue.objectId)
    viewerRef.current?.select(issue.objectId)
    viewerRef.current?.focus(issue.objectId)
    setRightTab('validation')
  }, [])

  // Inspector edits can touch anything — a vertex coordinate, a zone origin, GlobalGeometryRules
  // — so they rebuild the Model rather than trust the in-place sync to have covered it.
  const handleFieldChange = useCallback(
    (objectId: string, fieldIdx: number, newValue: string) => {
      const current = loadedRef.current
      if (!current) return
      if (!setFieldValue(current.doc, current.model, objectId, fieldIdx, newValue)) return
      commit({ rebuild: true })
    },
    [commit],
  )

  const handleRevertObject = useCallback(
    (objectId: string) => {
      const current = loadedRef.current
      if (!current) return
      if (!revertObject(current.doc, current.model, objectId)) return
      commit({ rebuild: true })
    },
    [commit],
  )

  const handleRevertAll = useCallback(() => {
    const current = loadedRef.current
    if (!current) return
    revertAll(current.doc, current.model)
    commit({ rebuild: true })
  }, [commit])

  /** Put a window or door on the selected wall, roof or floor, sized by prompt. */
  const addOpening = useCallback(
    async (type: 'Window' | 'Door') => {
      const current = loadedRef.current
      const selected = selectedRef.current
      const base = selected ? current?.model.surfaces.get(selected) : undefined
      if (!current || !selected || !base || base.kind !== 'base') {
        setNotice('Select a wall, roof or floor first.')
        return
      }
      const construction = suggestConstruction(current.doc, current.model, type === 'Window' ? 'window' : 'door')
      if (!construction) {
        setNotice(`No ${type.toLowerCase()} construction found in the file — add one first, or start from New.`)
        return
      }
      const extent = surfaceExtent(current.resolved.get(selected)!)
      const r1 = (v: number): number => Math.round(v * 10) / 10
      const defaults =
        type === 'Door'
          ? [0.9, Math.min(2.1, r1(extent.height - 0.1)), 0]
          : [r1(Math.min(extent.width * 0.5, 3)), r1(Math.min(1.5, extent.height * 0.5)), r1(Math.min(0.9, extent.height * 0.3))]
      const answer = await ask({
        title: `Add a ${type.toLowerCase()} to ${base.name}`,
        message: [`The surface is ${r1(extent.width)} m wide and ${r1(extent.height)} m high. Construction: ${construction}.`],
        fields: [
          { key: 'width', label: 'Width (m)', value: String(defaults[0]), kind: 'number' },
          { key: 'height', label: 'Height (m)', value: String(defaults[1]), kind: 'number' },
          { key: 'sill', label: type === 'Door' ? 'Above the floor (m)' : 'Sill height (m)', value: String(defaults[2]), kind: 'number' },
          { key: 'offset', label: 'From the left edge (m)', value: '', kind: 'number', hint: 'blank to centre it' },
        ],
        confirmLabel: `Add ${type.toLowerCase()}`,
      })
      if (!answer) return
      const [width, height, sill] = ['width', 'height', 'sill'].map((k) => Number(answer[k])) as [number, number, number]
      if (![width, height, sill].every(Number.isFinite)) {
        setNotice('Enter a number for width, height and sill.')
        return
      }
      const offsetText = answer['offset']!.trim()
      const result = placeOpening(current.doc, current.model, selected, {
        surfaceType: type,
        construction,
        width,
        height,
        sill,
        ...(offsetText === '' ? {} : { offset: Number(offsetText) }),
      })
      if (result.refused) {
        setNotice(`Cannot add the ${type.toLowerCase()}: ${result.refused}.`)
        return
      }
      setNotice(
        `Added a ${type.toLowerCase()} to ${base.name}` +
          (result.twinId ? ', and its matching opening on the interzone twin.' : '.'),
      )
      commit({ rebuild: true })
    },
    [ask, commit],
  )

  // Tens of milliseconds on the largest corpus file, so it simply follows every edit. Pairs the
  // matcher proposes between formerly exterior faces take the file's interior constructions.
  const matchReport = useMemo(
    () =>
      loaded
        ? proposeMatches(loaded.doc, loaded.model, loaded.resolved, undefined, {
            interiorConstructions: suggestInteriorConstructions(loaded.doc, loaded.model),
          })
        : undefined,
    [loaded],
  )

  /**
   * Tier-3 → detailed, as an explicit action with the consequences shown first — never automatic
   * (docs/05-implementation-plan.md §Phase 9).
   */
  const convertSimplified = useCallback(async () => {
    const current = loadedRef.current
    if (!current) return
    const plan = planTier3Conversion(current.doc, current.model)
    if (plan.conversions.length === 0 && plan.refused.length === 0) return
    const counts = new Map<string, number>()
    for (const c of plan.conversions) counts.set(c.sourceClass, (counts.get(c.sourceClass) ?? 0) + 1)
    const message = [
      `${plan.conversions.length} simplified object${plan.conversions.length === 1 ? '' : 's'} will be rewritten with explicit vertices, ` +
        'computed exactly as EnergyPlus computes them. Names are kept, so every reference still resolves.',
      ...[...counts].map(([k, n]) => `• ${k} ×${n}`),
      ...plan.notes,
      ...(plan.refused.length > 0
        ? [`${plan.refused.length} cannot be converted and will be left as they are:`, ...plan.refused.map((r) => `• ${r.name}: ${r.reason}`)]
        : []),
    ]
    if (plan.conversions.length === 0) {
      await ask({ title: 'Nothing can be converted', message, confirmLabel: 'OK' })
      return
    }
    if (!(await ask({ title: 'Convert simplified surfaces to detailed?', message, confirmLabel: 'Convert' }))) return
    const result = applyTier3Conversion(current.doc, current.model, plan)
    setNotice(`Converted ${result.removed.length} simplified objects into ${result.created.length} detailed ones. Ctrl+Z undoes it.`)
    commit({ rebuild: true })
    viewerRef.current?.fit()
  }, [ask, commit])

  const shareView = useCallback(async () => {
    const url = globalThis.location?.href ?? ''
    try {
      await navigator.clipboard.writeText(url)
      setNotice('Link to this view copied. Whoever opens the same file with it sees what you see.')
    } catch {
      // Some embedded browsers refuse clipboard access; the link is still there to copy by hand.
      await ask({
        title: 'Share this view',
        message: ['Whoever opens the same file with this link sees what you see. The model itself is not in the link.'],
        fields: [{ key: 'url', label: 'Link', value: url }],
        confirmLabel: 'Done',
      })
    }
  }, [ask])

  const saveImage = useCallback(() => {
    const viewer = viewerRef.current
    const current = loadedRef.current
    if (!viewer || !current) return
    const a = document.createElement('a')
    a.href = viewer.snapshot()
    a.download = current.name.replace(/\.[^.]+$/, '') + '.png'
    a.click()
  }, [])

  const applyMatches = useCallback(
    (proposals: MatchProposal[]) => {
      const current = loadedRef.current
      if (!current || proposals.length === 0) return
      const dirtied = applyMatchProposals(current.doc, current.model, proposals)
      setNotice(
        `Paired ${proposals.length} surface pair${proposals.length === 1 ? '' : 's'} — ` +
          `${dirtied.length} object${dirtied.length === 1 ? '' : 's'} changed. Ctrl+Z undoes it.`,
      )
      commit({ rebuild: true })
    },
    [commit],
  )

  const model = loaded?.model
  const validation = loaded?.validation
  const errorCount = validation?.errorCount ?? 0
  const warningCount = validation?.warningCount ?? 0
  const unrendered = model ? [...model.unrendered.values()].reduce((a, b) => a + b, 0) : 0
  const dirtyObjects = loaded ? getDirtyObjects(loaded.doc) : []
  const currentText = useMemo(() => (loaded ? emitIdf(loaded.doc) : ''), [loaded])

  const filteredIssues = (validation?.issues ?? []).filter((issue) => {
    if (validationFilter === 'error') return issue.severity === 'error'
    if (validationFilter === 'warning') return issue.severity === 'warning'
    return true
  })

  return (
    <div
      className={`app${dragging ? ' app--dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="bar">
        <strong>cartes</strong>
        <button type="button" onClick={newModel} title="Start a new model from the authoring template">
          New
        </button>
        <label className="file">
          Open IDF
          <input
            type="file"
            accept=".idf,.imf,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void open(file)
            }}
          />
        </label>

        {loaded && (
          <>
            <button
              type="button"
              className={showTree ? 'button--active' : ''}
              onClick={() => setShowTree(!showTree)}
              title="Toggle Object Tree"
            >
              Tree
            </button>

            <button
              type="button"
              className={showRightPanel && rightTab === 'inspector' ? 'button--active' : ''}
              onClick={() => {
                if (showRightPanel && rightTab === 'inspector') setShowRightPanel(false)
                else {
                  setRightTab('inspector')
                  setShowRightPanel(true)
                }
              }}
              title="Toggle Inspector"
            >
              Inspector
            </button>

            <button
              type="button"
              className={showRightPanel && rightTab === 'validation' ? 'button--active' : ''}
              onClick={() => {
                if (showRightPanel && rightTab === 'validation') setShowRightPanel(false)
                else {
                  setRightTab('validation')
                  setShowRightPanel(true)
                }
              }}
              title="Toggle Validation"
            >
              Validation ({validation?.issues.length ?? 0})
            </button>

            <button
              type="button"
              className={showRightPanel && rightTab === 'matching' ? 'button--active' : ''}
              onClick={() => {
                if (showRightPanel && rightTab === 'matching') setShowRightPanel(false)
                else {
                  setRightTab('matching')
                  setShowRightPanel(true)
                }
              }}
              title="Review proposed interzone surface pairs"
            >
              Matching ({matchReport?.proposals.length ?? 0})
            </button>

            <button
              type="button"
              className={dirtyObjects.length > 0 ? 'button--active' : ''}
              onClick={() => setShowDiff(true)}
              title="View live diff and raw text"
            >
              Changes ({dirtyObjects.length})
            </button>
          </>
        )}

        <label>
          Colour by{' '}
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="type">surface type</option>
            <option value="construction">construction</option>
          </select>
        </label>

        <button type="button" onClick={() => viewerRef.current?.fit()}>
          Fit
        </button>

        {loaded && storeys && storeys.storeys.length > 1 && (
          <label title="Pull storeys apart, or show one at a time">
            Storeys{' '}
            <select
              value={display.mode === 'solo' ? `solo:${display.storey}` : display.mode}
              onChange={(e) => {
                const v = e.target.value
                const next: DisplayState =
                  v === 'exploded' ? { mode: 'exploded' } : v.startsWith('solo:') ? { mode: 'solo', storey: Number(v.slice(5)) } : { mode: 'stacked' }
                setDisplay(next)
                // Editing works in the model's own frame; with storeys moved or hidden it would not.
                if (next.mode !== 'stacked') {
                  setEditMode('off')
                  setActiveHandle(undefined)
                }
              }}
            >
              <option value="stacked">stacked</option>
              <option value="exploded">exploded</option>
              {storeys.storeys.map((st) => (
                <option key={st.index} value={`solo:${st.index}`}>
                  storey {st.index + 1} only (z {+st.z.toFixed(2)} m, {st.zoneIds.length} zone{st.zoneIds.length === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>
        )}

        {loaded && (
          <>
            <button type="button" onClick={shareView} title="Copy a link to this view">
              Link
            </button>
            <button type="button" onClick={saveImage} title="Save the view as a PNG image">
              Image
            </button>
          </>
        )}

        {loaded && (
          <>
            <span className="bar__group" role="group" aria-label="Edit geometry">
              {(['off', 'vertex', 'corner', 'draw'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={mode !== 'off' && display.mode !== 'stacked'}
                  className={editMode === mode ? 'button--active' : ''}
                  onClick={() => {
                    setEditMode(mode)
                    setActiveHandle(undefined)
                    // Drawing without a grid means corners at 3.0417 m; with one, at 3.0 m.
                    if (mode === 'draw' && !snap.grid) setSnap({ ...snap, grid: true })
                    setNotice(
                      mode === 'vertex'
                        ? 'Select a surface, then drag a handle within its plane. Double-click an edge to add a vertex; Delete removes the active vertex, or the surface.'
                        : mode === 'corner'
                          ? 'Select a surface, then drag a corner in plan: everything on that vertical edge moves together.'
                          : mode === 'draw'
                            ? 'Click to place the corners of a new zone — on the ground, or on top of a selected roof. Double-click, Enter, or click the first corner to finish; Backspace removes a corner; Esc cancels.'
                            : undefined,
                    )
                  }}
                  title={
                    mode === 'off'
                      ? 'Select and inspect only'
                      : mode === 'vertex'
                        ? 'Drag vertices within their surface plane'
                        : mode === 'corner'
                          ? 'Drag building corners in plan'
                          : 'Draw a zone footprint and extrude it'
                  }
                >
                  {mode === 'off' ? 'Select' : mode === 'vertex' ? 'Vertex' : mode === 'corner' ? 'Corner' : 'Draw zone'}
                </button>
              ))}
            </span>

            {editMode !== 'off' && (
              <span className="bar__group" role="group" aria-label="Snapping">
                Snap
                {(['vertex', 'edge', 'grid'] as const).map((kind) => (
                  <label key={kind} className="bar__check">
                    <input
                      type="checkbox"
                      checked={snap[kind]}
                      onChange={(e) => setSnap({ ...snap, [kind]: e.target.checked })}
                    />
                    {kind}
                  </label>
                ))}
                {snap.grid && (
                  <select
                    value={snap.gridSize}
                    onChange={(e) => setSnap({ ...snap, gridSize: Number(e.target.value) })}
                    title="Grid spacing"
                  >
                    {[0.01, 0.05, 0.1, 0.25, 0.5, 1].map((g) => (
                      <option key={g} value={g}>
                        {g} m
                      </option>
                    ))}
                  </select>
                )}
              </span>
            )}

            {selectedId && loaded.model.surfaces.get(selectedId)?.kind === 'base' && (
              <>
                <button type="button" onClick={() => addOpening('Window')} title="Add a window to the selected surface">
                  + Window
                </button>
                <button type="button" onClick={() => addOpening('Door')} title="Add a door to the selected surface">
                  + Door
                </button>
              </>
            )}

            {editMode !== 'off' && editMode !== 'draw' && selectedId && loaded.model.surfaces.has(selectedId) && (
              <>
                <button type="button" onClick={moveZone} title="Translate the selected surface's zone">
                  Move zone…
                </button>
                <button type="button" onClick={deleteSelection} title="Delete the active vertex, or the surface">
                  Delete
                </button>
              </>
            )}

            <button
              type="button"
              onClick={undo}
              disabled={!loaded.history.canUndo}
              title={loaded.history.undoLabel ? `Undo ${loaded.history.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!loaded.history.canRedo}
              title={loaded.history.redoLabel ? `Redo ${loaded.history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
            >
              Redo
            </button>
          </>
        )}

        <span className="spacer" />
        {loaded && (
          <span className="meta">
            {loaded.name} · EnergyPlus {loaded.model.version} ·{' '}
            {loaded.model.rules.coordinateSystem} coordinates · {loaded.model.zones.size} zones ·{' '}
            {stats?.drawn ?? 0} surfaces · {Math.round(loaded.ms)} ms
          </span>
        )}
      </header>

      <div className="workspace">
        {/* Left Drawer: Object Tree */}
        {loaded && showTree && (
          <ObjectTree
            doc={loaded.doc}
            model={loaded.model}
            selectedId={selectedId}
            onSelect={selectObject}
            onFocus={focusObject}
          />
        )}

        {/* Center: 3D Stage */}
        <div className="stage">
          <canvas
            ref={canvasRef}
            className={editMode !== 'off' ? 'canvas--edit' : undefined}
            onPointerDownCapture={onPointerDownCapture}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={endDrag}
            onPointerMove={onPointerMove}
            onDoubleClick={onDoubleClick}
            onPointerLeave={() => setHover(undefined)}
          />

          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button type="button" className="notice__close" onClick={() => setNotice(undefined)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          {!loaded && !error && (
            <p className="empty">Drop an .idf file here, or use Open IDF.</p>
          )}

          {loaded && stats?.drawn === 0 && (
            <div className="empty empty--explain">
              {unrendered > 0 ? (
                <>
                  <p>
                    Nothing to draw: every surface in this file uses EnergyPlus&rsquo;s
                    <em> simplified rectangular </em> classes.
                  </p>
                  <p className="empty__detail">
                    {[...model!.unrendered].map(([k, n]) => `${k} ×${n}`).join(', ')}
                  </p>
                  <p className="empty__detail">
                    cartes reads and preserves them exactly — saving this file returns it
                    byte-for-byte. Converting them writes the vertices EnergyPlus would compute.
                  </p>
                  <p>
                    <button type="button" className="empty__action" onClick={convertSimplified}>
                      Convert to detailed…
                    </button>
                  </p>
                </>
              ) : (
                <p>No geometry yet. Choose <strong>Draw zone</strong> and click on the ground to start.</p>
              )}
            </div>
          )}

          {hover && (
            <div className="hover">
              <div className="hover__name">{hover.name}</div>
              <dl>
                <dt>Class</dt>
                <dd>{hover.className}</dd>
                <dt>Construction</dt>
                <dd>{hover.construction}</dd>
                <dt>Zone</dt>
                <dd>{hover.zone}</dd>
              </dl>
            </div>
          )}
        </div>

        {/* Right Drawer: Inspector or Validation */}
        {loaded && showRightPanel && (
          <aside className="right-panel">
            <div className="right-panel__tabs">
              <button
                type="button"
                className={`right-panel__tab${rightTab === 'inspector' ? ' right-panel__tab--active' : ''}`}
                onClick={() => setRightTab('inspector')}
              >
                Inspector
              </button>
              <button
                type="button"
                className={`right-panel__tab${rightTab === 'validation' ? ' right-panel__tab--active' : ''}`}
                onClick={() => setRightTab('validation')}
              >
                Validation ({validation?.issues.length ?? 0})
              </button>
              <button
                type="button"
                className={`right-panel__tab${rightTab === 'matching' ? ' right-panel__tab--active' : ''}`}
                onClick={() => setRightTab('matching')}
              >
                Matching ({matchReport?.proposals.length ?? 0})
              </button>
            </div>

            <div className="right-panel__body">
              {rightTab === 'matching' && matchReport ? (
                <MatchPanel
                  model={loaded.model}
                  report={matchReport}
                  selectedId={selectedId}
                  onSelect={(id) => {
                    setSelectedId(id)
                    viewerRef.current?.select(id)
                    viewerRef.current?.focus(id)
                  }}
                  onApply={applyMatches}
                />
              ) : rightTab === 'inspector' ? (
                <Inspector
                  doc={loaded.doc}
                  model={loaded.model}
                  selectedId={selectedId}
                  onFieldChange={handleFieldChange}
                  onRevertObject={handleRevertObject}
                />
              ) : (
                <div className="validation-panel" style={{ position: 'static', width: '100%', height: '100%' }}>
                  <div className="validation-panel__tabs">
                    <button
                      type="button"
                      className={`validation-panel__tab${validationFilter === 'all' ? ' validation-panel__tab--active' : ''}`}
                      onClick={() => setValidationFilter('all')}
                    >
                      All ({validation?.issues.length ?? 0})
                    </button>
                    <button
                      type="button"
                      className={`validation-panel__tab${validationFilter === 'error' ? ' validation-panel__tab--active' : ''}`}
                      onClick={() => setValidationFilter('error')}
                    >
                      Errors ({errorCount})
                    </button>
                    <button
                      type="button"
                      className={`validation-panel__tab${validationFilter === 'warning' ? ' validation-panel__tab--active' : ''}`}
                      onClick={() => setValidationFilter('warning')}
                    >
                      Warnings ({warningCount})
                    </button>
                  </div>

                  <div className="validation-panel__list">
                    {filteredIssues.length === 0 ? (
                      <div className="validation-panel__empty">
                        No {validationFilter === 'all' ? '' : validationFilter} issues found.
                      </div>
                    ) : (
                      filteredIssues.map((issue, idx) => {
                        const isSelected = selectedId === issue.objectId
                        return (
                          <div
                            key={`${issue.objectId}:${issue.code}:${idx}`}
                            className={`issue-card issue-card--${issue.severity}${isSelected ? ' issue-card--selected' : ''}`}
                            onClick={() => selectIssue(issue)}
                          >
                            <div className="issue-card__top">
                              <span className={`issue-card__badge issue-card__badge--${issue.severity}`}>
                                {issue.severity}
                              </span>
                              <span className="issue-card__code">{issue.code}</span>
                            </div>
                            <div className="issue-card__name">{issue.objectName}</div>
                            <p className="issue-card__msg">{issue.message}</p>
                            {issue.relatedObjectName && (
                              <div className="issue-card__relation">
                                Related: {issue.relatedObjectName}
                              </div>
                            )}
                            {issue.fixDescription && (
                              <div className="issue-card__tip">Tip: {issue.fixDescription}</div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {dialog}

      {/* Live Diff / Raw IDF Modal */}
      {loaded && showDiff && (
        <DiffPanel
          doc={loaded.doc}
          originalText={loaded.originalSource}
          currentText={currentText}
          fileName={loaded.name}
          onClose={() => setShowDiff(false)}
          onRevertAll={handleRevertAll}
        />
      )}

      <footer className="bar bar--foot">
        {error && <span className="alert alert--error">Could not read the file: {error}</span>}
        {unrendered > 0 && (stats?.drawn ?? 0) > 0 && (
          <span className="alert">
            {unrendered} object{unrendered === 1 ? '' : 's'} not drawn (
            {[...model!.unrendered].map(([k, n]) => `${k} ×${n}`).join(', ')}){' '}
            <button type="button" className="alert__action" onClick={convertSimplified}>
              Convert to detailed…
            </button>
          </span>
        )}
        {stats && stats.skipped > 0 && (
          <span className="alert">
            {stats.skipped} surface{stats.skipped === 1 ? '' : 's'} had too few vertices to draw
          </span>
        )}
        {validation && (errorCount > 0 || warningCount > 0) && (
          <span
            className={`alert ${errorCount > 0 ? 'alert--error' : 'alert--warning'} alert--clickable`}
            onClick={() => {
              setRightTab('validation')
              setShowRightPanel(true)
            }}
            title="Click to view validation issues"
          >
            {errorCount > 0 && `${errorCount} error${errorCount === 1 ? '' : 's'}`}
            {errorCount > 0 && warningCount > 0 && ', '}
            {warningCount > 0 && `${warningCount} warning${warningCount === 1 ? '' : 's'}`}
          </span>
        )}
        {dirtyObjects.length > 0 && (
          <span
            className="alert alert--clickable"
            onClick={() => setShowDiff(true)}
            title="Click to view live diff"
          >
            {dirtyObjects.length} object{dirtyObjects.length === 1 ? '' : 's'} modified
          </span>
        )}
      </footer>
    </div>
  )
}
