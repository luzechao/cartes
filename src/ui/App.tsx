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
  buildModel,
  setFieldValue,
  revertObject,
  revertAll,
  getDirtyObjects,
  type Model,
} from '../model/index.js'
import {
  resolveModel,
  validateModel,
  type ResolvedSurface,
  type ValidationIssue,
  type ValidationReport,
} from '../geometry/index.js'
import { buildScene, Viewer, type ColorBy, type HoverInfo } from '../render/index.js'
import { ObjectTree } from './ObjectTree.js'
import { Inspector } from './Inspector.js'
import { DiffPanel } from './DiffPanel.js'

interface LoadedFile {
  name: string
  doc: IdfDocument
  model: Model
  resolved: Map<string, ResolvedSurface>
  validation: ValidationReport
  originalSource: string
  /** Parse + model + resolve + validate, in milliseconds. */
  ms: number
}

interface BuildStats {
  drawn: number
  /** Surfaces with too little geometry to draw. Never silently dropped. */
  skipped: number
}

type RightPanelTab = 'inspector' | 'validation'
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
      setLoaded({
        name: file.name,
        doc,
        model,
        resolved,
        validation,
        originalSource: text,
        ms: performance.now() - started,
      })
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

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    pointerDownRef.current = { x: event.clientX, y: event.clientY }
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const down = pointerDownRef.current
    if (!down) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) {
      const hit = viewerRef.current?.pick(event.clientX, event.clientY)
      setSelectedId(hit?.id)
      viewerRef.current?.select(hit?.id)
      if (hit?.id) {
        setRightTab('inspector')
        setShowRightPanel(true)
      }
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    setHover(viewerRef.current?.pick(event.clientX, event.clientY))
  }, [])

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

  const handleFieldChange = useCallback(
    (objectId: string, fieldIdx: number, newValue: string) => {
      if (!loaded) return
      const changed = setFieldValue(loaded.doc, loaded.model, objectId, fieldIdx, newValue)
      if (!changed) return

      const resolved = resolveModel(loaded.model)
      const validation = validateModel(loaded.model, resolved, loaded.doc)
      setLoaded({
        ...loaded,
        resolved,
        validation,
      })
      viewerRef.current?.setColorBy(colorBy)
    },
    [loaded, colorBy],
  )

  const handleRevertObject = useCallback(
    (objectId: string) => {
      if (!loaded) return
      const reverted = revertObject(loaded.doc, loaded.model, objectId)
      if (!reverted) return

      const resolved = resolveModel(loaded.model)
      const validation = validateModel(loaded.model, resolved, loaded.doc)
      setLoaded({
        ...loaded,
        resolved,
        validation,
      })
      viewerRef.current?.setColorBy(colorBy)
    },
    [loaded, colorBy],
  )

  const handleRevertAll = useCallback(() => {
    if (!loaded) return
    revertAll(loaded.doc, loaded.model)
    const resolved = resolveModel(loaded.model)
    const validation = validateModel(loaded.model, resolved, loaded.doc)
    setLoaded({
      ...loaded,
      resolved,
      validation,
    })
    viewerRef.current?.setColorBy(colorBy)
  }, [loaded, colorBy])

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
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(undefined)}
          />

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
            </div>

            <div className="right-panel__body">
              {rightTab === 'inspector' ? (
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
