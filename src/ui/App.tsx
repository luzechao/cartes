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
  setFieldValue,
  revertObject,
  revertAll,
  getDirtyObjects,
  planSurfaceDeletion,
  type Model,
} from '../model/index.js'
import {
  applyMatchProposals,
  applyZoneTranslation,
  DEFAULT_SNAP_SETTINGS,
  deleteVertex,
  DragSession,
  insertVertexWorld,
  intersectRayPlane,
  nearestEdge,
  planDrag,
  planeOfSurface,
  planZoneTranslation,
  proposeMatches,
  resolveModel,
  resolveSurface,
  transformContext,
  validateModel,
  type DragMode,
  type MatchProposal,
  type ResolvedSurface,
  type SnapSettings,
  type TwinOutcome,
  type ValidationIssue,
  type ValidationReport,
} from '../geometry/index.js'
import { buildScene, Viewer, type ColorBy, type HoverInfo } from '../render/index.js'
import { ObjectTree } from './ObjectTree.js'
import { Inspector } from './Inspector.js'
import { DiffPanel } from './DiffPanel.js'
import { MatchPanel } from './MatchPanel.js'

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

type EditMode = 'off' | DragMode

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

  // Pointer and keyboard handlers outlive a render; they read the current state through these.
  const loadedRef = useRef<LoadedFile | undefined>(undefined)
  const selectedRef = useRef<string | undefined>(undefined)
  const editModeRef = useRef<EditMode>('off')
  const activeHandleRef = useRef<number | undefined>(undefined)
  const dragRef = useRef<ActiveDrag | undefined>(undefined)
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
    const build = buildScene(loaded.model, loaded.resolved, { colorBy })
    viewer.setBuild(build)
    viewer.fit()
    setStats({ drawn: build.registry.size, skipped: build.skipped.length })
    setHover(undefined)
    setSelectedId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.originalSource])

  useEffect(() => {
    viewerRef.current?.setColorBy(colorBy)
  }, [colorBy])

  const open = useCallback(async (file: File) => {
    try {
      setError(undefined)
      const text = await file.text()
      const started = performance.now()
      const doc = parseIdf(text)
      const model = buildModel(doc)
      const resolved = resolveModel(model)
      const validation = validateModel(model, resolved, doc)
      loadedRef.current?.history.detach()
      setLoaded({
        name: file.name,
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
    if (!current || !viewer || mode === 'off' || !selected || event.button !== 0) return

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
    [endDrag],
  )

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    const current = loadedRef.current
    const viewer = viewerRef.current
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
  }, [])

  /** Double-click on an edge of the selected surface: split it there. */
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const current = loadedRef.current
      const viewer = viewerRef.current
      const selected = selectedRef.current
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
    [commit],
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
  const deleteSelection = useCallback(() => {
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
    const lines = [`Delete ${plan.className} '${plan.surfaceName}'?`]
    if (plan.cascade.length > 0) {
      lines.push('', 'Also deleted, because they cannot exist without it:')
      for (const c of plan.cascade) lines.push(`  • ${c.className} '${c.name}'`)
    }
    const others = [...plan.otherReferences, ...plan.undeclaredMentions]
    if (others.length > 0) {
      lines.push('', `${others.length} other field(s) name it and will be left dangling:`)
      for (const r of others.slice(0, 8)) lines.push(`  • ${doc.objects.get(r.fromId)?.className ?? r.fromClassKey}: ${r.fieldName}`)
    }
    if (!window.confirm(lines.join('\n'))) return

    let twins: 'leave' | 'adiabatic' = 'leave'
    if (plan.twins.length > 0) {
      twins = window.confirm(
        `${plan.twins.map((t) => `'${t.name}'`).join(', ')} name${plan.twins.length === 1 ? 's' : ''} this surface as ` +
          'its interzone twin. EnergyPlus will not run while that reference dangles.\n\n' +
          'OK: set the twin to Adiabatic.  Cancel: leave it for you to fix.',
      )
        ? 'adiabatic'
        : 'leave'
    }
    const result = applySurfaceDeletion(doc, model, plan, { twins })
    setNotice(
      `Deleted ${result.deleted.length} object${result.deleted.length === 1 ? '' : 's'}` +
        (result.repairedTwins.length > 0 ? `; ${result.repairedTwins.length} twin set to Adiabatic.` : '.'),
    )
    commit({ rebuild: true })
  }, [commit])

  /** Move the selected surface's whole zone by a typed offset. */
  const moveZone = useCallback(() => {
    const current = loadedRef.current
    const selected = selectedRef.current
    if (!current || !selected) return
    const zoneId = current.model.zoneOf.get(selected)
    const zone = zoneId === undefined ? undefined : current.model.zones.get(zoneId)
    if (!zone || !zoneId) {
      setNotice('The selected surface belongs to no zone.')
      return
    }
    const answer = window.prompt(`Move zone '${zone.name}' by dx, dy, dz (metres, world axes):`, '0, 0, 0')
    if (answer === null) return
    const parts = answer.split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      setNotice('Enter three numbers: dx, dy, dz.')
      return
    }
    const [x, y, z] = parts as [number, number, number]
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
    if (warnings.length > 0 && !window.confirm(`${warnings.join('\n\n')}\n\nMove the zone anyway?`)) return
    const result = applyZoneTranslation(current.doc, current.model, plan)
    setNotice(`Moved zone '${zone.name}' — ${result.dirtied.length} object${result.dirtied.length === 1 ? '' : 's'} changed.`)
    commit({ rebuild: true })
  }, [commit])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        event.preventDefault()
        redo()
      } else if ((key === 'delete' || key === 'backspace') && editModeRef.current !== 'off') {
        event.preventDefault()
        deleteSelection()
      } else if (key === 'escape') {
        setActiveHandle(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelection])

  // Vertex handles follow the selection in edit mode.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || dragRef.current) return
    const r = editMode !== 'off' && selectedId ? loaded?.resolved.get(selectedId) : undefined
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

  // Tens of milliseconds on the largest corpus file, so it simply follows every edit.
  const matchReport = useMemo(
    () => (loaded ? proposeMatches(loaded.doc, loaded.model, loaded.resolved) : undefined),
    [loaded],
  )

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

        {loaded && (
          <>
            <span className="bar__group" role="group" aria-label="Edit geometry">
              {(['off', 'vertex', 'corner'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={editMode === mode ? 'button--active' : ''}
                  onClick={() => {
                    setEditMode(mode)
                    setActiveHandle(undefined)
                    setNotice(
                      mode === 'vertex'
                        ? 'Select a surface, then drag a handle within its plane. Double-click an edge to add a vertex; Delete removes the active vertex, or the surface.'
                        : mode === 'corner'
                          ? 'Select a surface, then drag a corner in plan: everything on that vertical edge moves together.'
                          : undefined,
                    )
                  }}
                  title={
                    mode === 'off'
                      ? 'Select and inspect only'
                      : mode === 'vertex'
                        ? 'Drag vertices within their surface plane'
                        : 'Drag building corners in plan'
                  }
                >
                  {mode === 'off' ? 'Select' : mode === 'vertex' ? 'Vertex' : 'Corner'}
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

            {editMode !== 'off' && selectedId && loaded.model.surfaces.has(selectedId) && (
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
                    byte-for-byte — but does not yet derive their vertices.
                  </p>
                </>
              ) : (
                <p>This file contains no surface geometry.</p>
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
            {[...model!.unrendered].map(([k, n]) => `${k} ×${n}`).join(', ')})
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
