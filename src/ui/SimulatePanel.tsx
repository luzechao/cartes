/**
 * Sidebar Simulate panel: what the engine is doing and what it said. Inputs and the Run command live in the
 * ribbon's Simulate tab; this panel shows the run status, EnergyPlus's console output, its messages, and the
 * output files.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { versionNote } from '../simulate/index.js'
import { scenarioArchiveName, scenarioStore, type SavedScenario } from '../simulate/scenarioStore.js'
import { useDialog } from './Dialog.js'
import type { Simulation } from './useSimulation.js'

interface SimulatePanelProps {
  simulation: Simulation
  idfVersion: string | undefined
  hasModel: boolean
}

type View = 'console' | 'messages' | 'files'
type MessageFilter = 'problems' | 'all'

export function SimulatePanel({ simulation, idfVersion, hasModel }: SimulatePanelProps): React.JSX.Element {
  const { engine, result, running, log } = simulation
  const [view, setView] = useState<View>('console')
  const [filter, setFilter] = useState<MessageFilter>('problems')
  const consoleRef = useRef<HTMLPreElement | null>(null)
  const followConsole = useRef(true)
  const pinnedScrollTop = useRef(0)

  useEffect(() => {
    if (hasModel) simulation.loadEngine()
  }, [hasModel, simulation.loadEngine])

  // Keep the console scrolled to the newest line unless the user scrolled up to read. The status card above it
  // changes height when a run starts or ends, so re-pin then too.
  useLayoutEffect(() => {
    const el = consoleRef.current
    if (!el || !followConsole.current) return
    el.scrollTop = el.scrollHeight
    pinnedScrollTop.current = el.scrollTop
  }, [log, view, running, result])

  const note = hasModel ? versionNote(idfVersion) : undefined
  const problems = result?.messages.filter((m) => m.severity !== 'warning') ?? []
  const messages = filter === 'all' ? (result?.messages ?? []) : problems

  return (
    <div className="simulate-panel">
      <section className="simulate-panel__section">
        <div className="simulate-panel__engine">
          {engine.state === 'ready' && (
            <>
              EnergyPlus {engine.info.energyPlusVersion} · Pyodide {engine.info.pyodideVersion} · loaded in{' '}
              {engine.info.seconds.toFixed(1)} s
            </>
          )}
          {engine.state === 'idle' && <>Open a model to load EnergyPlus.</>}
          {engine.state === 'loading' && (
            <>Loading EnergyPlus and Pyodide (~45 MB, cached after the first visit)…</>
          )}
          {engine.state === 'error' && <span className="simulate-panel__error">Engine failed to load: {engine.message}</span>}
        </div>
        {note && <div className="simulate-panel__note">{note}</div>}

        {running && (
          <div className="simulate-panel__status simulate-panel__status--running">
            <strong>Simulating…</strong>
            <span>{log.length} lines</span>
          </div>
        )}
        {!running && result && (
          <>
            <div className={`simulate-panel__status simulate-panel__status--${result.summary?.success ? 'ok' : 'failed'}`}>
              <strong>{result.summary?.success ? 'Completed' : 'Failed'}</strong>
              <span>
                {result.summary ? `${result.summary.warnings} warnings · ${result.summary.severe} severe` : `exit ${result.exitCode}`} ·{' '}
                {result.seconds.toFixed(1)} s
              </span>
            </div>
            <div className="simulate-panel__hint">
              {result.modelName}
              {result.edited ? ' (with unsaved edits)' : ''}
              {result.args.includes('-D') ? ' · design days only' : ' · weather file run'}
            </div>
          </>
        )}
        {!running && !result && !simulation.runError && (
          <div className="simulate-panel__hint">Set inputs and run from the ribbon’s Simulate tab.</div>
        )}
        {simulation.runError && <div className="simulate-panel__error">{simulation.runError}</div>}
      </section>

      <div className="validation-panel__tabs">
        <ViewTab id="console" label="Console" view={view} onSelect={setView} />
        <ViewTab id="messages" label={`Messages${result ? ` (${result.messages.length})` : ''}`} view={view} onSelect={setView} />
        <ViewTab id="files" label={`Files${result ? ` (${simulation.outputs.length})` : ''}`} view={view} onSelect={setView} />
      </div>

      {view === 'console' && (
        <pre
          ref={consoleRef}
          className="simulate-panel__console"
          onScroll={(e) => {
            const el = e.currentTarget
            // Only a scroll above where we pinned it is the user's; growth below it is new output arriving.
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) followConsole.current = true
            else if (el.scrollTop < pinnedScrollTop.current) followConsole.current = false
          }}
        >
          {log.length > 0 ? log.join('\n') : <span className="simulate-panel__placeholder">EnergyPlus output appears here during a run.</span>}
        </pre>
      )}

      {view === 'messages' && (
        <div className="simulate-panel__list">
          {!result ? (
            <div className="validation-panel__empty">No run yet.</div>
          ) : (
            <>
              <div className="simulate-panel__filter">
                <label>
                  <input type="radio" checked={filter === 'problems'} onChange={() => setFilter('problems')} /> Severe & fatal (
                  {problems.length})
                </label>
                <label>
                  <input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} /> All ({result.messages.length})
                </label>
              </div>
              {messages.length === 0 ? (
                <div className="validation-panel__empty">
                  {filter === 'problems' ? 'No severe or fatal errors.' : 'EnergyPlus reported no messages.'}
                </div>
              ) : (
                messages.map((m, idx) => {
                  const level = m.severity === 'warning' ? 'warning' : 'error'
                  return (
                    <div key={idx} className={`issue-card issue-card--${level}`}>
                      <div className="issue-card__top">
                        <span className={`issue-card__badge issue-card__badge--${level}`}>{m.severity}</span>
                      </div>
                      <p className="issue-card__msg">{m.message}</p>
                      {m.details.length > 0 && <div className="issue-card__relation">{m.details.join(' ')}</div>}
                    </div>
                  )
                })
              )}
            </>
          )}
        </div>
      )}

      {view === 'files' && (
        <div className="simulate-panel__list">
          <strong>Current run</strong>
          {simulation.outputs.length === 0 ? (
            <div className="validation-panel__empty">No current output files.</div>
          ) : (
            simulation.outputs.map((file) => (
              <a key={file.name} className="simulate-panel__file-row" href={file.url} download={file.name}>
                <span>{file.name}</span>
                <span className="simulate-panel__size">{formatSize(file.size)}</span>
              </a>
            ))
          )}
          <SavedScenarios runs={simulation.savedScenarios} storageError={simulation.scenarioStorageError} />
        </div>
      )}
    </div>
  )
}

function SavedScenarios({ runs, storageError }: { runs: SavedScenario[]; storageError: string | undefined }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [download, setDownload] = useState<{ id: number; url: string; name: string; label: string } | undefined>()
  const mounted = useRef(true)
  const dialog = useDialog()
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url) }, [download])

  async function prepare(run: SavedScenario, file?: { kind: 'model' | 'output'; name: string }): Promise<void> {
    setBusy(true)
    setError(undefined)
    setDownload(undefined)
    try {
      const bytes = file === undefined ? await scenarioStore.archive(run.id) : await scenarioStore.file(run.id, file.kind, file.name)
      if (mounted.current) {
        const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], {
          type: file === undefined ? 'application/zip' : 'application/octet-stream',
        }))
        const safeName = file?.name.replace(/[\\/\x00-\x1f]/g, '_')
        setDownload({
          id: run.id, url, name: file === undefined ? scenarioArchiveName(run) : safeName === '.' || safeName === '..' ? 'output' : safeName || 'output',
          label: file === undefined ? 'ZIP' : file.name,
        })
      }
    } catch (reason) {
      if (mounted.current) setError(`Could not prepare download: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function remove(run: SavedScenario): Promise<void> {
    const confirmed = await dialog.ask({
      title: 'Delete saved scenario?',
      message: [`Delete the locally saved files for "${run.result.name}"? Downloaded archives are not affected.`],
      confirmLabel: 'Delete', danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    setError(undefined)
    try {
      await scenarioStore.remove(run.id)
      if (download?.id === run.id) setDownload(undefined)
    } catch (reason) {
      setError(`Could not delete scenario: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="simulate-panel__saved">
      <strong>Saved scenarios ({runs.length})</strong>
      <p>Stored locally in this browser, including across reloads. Storage may be cleared or evicted; download files for safekeeping. ZIPs are limited to 256 MiB and need extra memory.</p>
      {storageError && <div className="simulate-panel__error">Scenario storage unavailable: {storageError}</div>}
      {error && <div className="simulate-panel__error">{error}</div>}
      {runs.length === 0 && !storageError && <div className="validation-panel__empty">No saved scenarios.</div>}
      {runs.map((run) => (
        <details key={run.id} className="simulate-panel__saved-run">
          <summary>{run.result.name} · {run.result.status}</summary>
          <div className="simulate-panel__hint">
            #{run.id} · {run.modelName} · {new Date(run.createdAt).toLocaleString()} · {run.outputNames.length} files · {formatSize(run.outputBytes)}
          </div>
          <div className="simulate-panel__hint">{run.weather} · EnergyPlus {run.engineVersion}</div>
          <div className="simulate-panel__saved-actions">
            <button type="button" disabled={busy} onClick={() => void prepare(run)}>{busy ? 'Working…' : 'Prepare ZIP'}</button>
            <button type="button" disabled={busy} onClick={() => void remove(run)}>Delete</button>
          </div>
          {download?.id === run.id && <a className="simulate-panel__file-row" href={download.url} download={download.name}>Download {download.label}</a>}
          <details className="simulate-panel__saved-files">
            <summary>Individual files</summary>
            <button type="button" disabled={busy} onClick={() => void prepare(run, { kind: 'model', name: 'scenario.idf' })}>Simulated model (scenario.idf)</button>
            {run.outputNames.map((name) => (
              <button key={name} type="button" disabled={busy} onClick={() => void prepare(run, { kind: 'output', name })}>{name}</button>
            ))}
          </details>
        </details>
      ))}
      {dialog.element}
    </section>
  )
}

function ViewTab({ id, label, view, onSelect }: { id: View; label: string; view: View; onSelect: (v: View) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`validation-panel__tab${view === id ? ' validation-panel__tab--active' : ''}`}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
