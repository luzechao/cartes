/**
 * Sidebar Simulate panel: what the engine is doing and what it said. Inputs and the Run command live in the
 * ribbon's Simulate tab; this panel shows the run status, EnergyPlus's console output, its messages, and the
 * output files.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { versionNote } from '../simulate/index.js'
import type { Simulation } from './useSimulation.js'

interface SimulatePanelProps {
  simulation: Simulation
  idfVersion: string | undefined
}

type View = 'console' | 'messages' | 'files'
type MessageFilter = 'problems' | 'all'

export function SimulatePanel({ simulation, idfVersion }: SimulatePanelProps): React.JSX.Element {
  const { engine, result, running, log } = simulation
  const [view, setView] = useState<View>('console')
  const [filter, setFilter] = useState<MessageFilter>('problems')
  const consoleRef = useRef<HTMLPreElement | null>(null)
  const followConsole = useRef(true)
  const pinnedScrollTop = useRef(0)

  useEffect(() => {
    simulation.loadEngine()
  }, [simulation.loadEngine])

  // Keep the console scrolled to the newest line unless the user scrolled up to read. The status card above it
  // changes height when a run starts or ends, so re-pin then too.
  useLayoutEffect(() => {
    const el = consoleRef.current
    if (!el || !followConsole.current) return
    el.scrollTop = el.scrollHeight
    pinnedScrollTop.current = el.scrollTop
  }, [log, view, running, result])

  const note = versionNote(idfVersion)
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
          {(engine.state === 'loading' || engine.state === 'idle') && (
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
          {simulation.outputs.length === 0 ? (
            <div className="validation-panel__empty">No output files yet.</div>
          ) : (
            simulation.outputs.map((file) => (
              <a key={file.name} className="simulate-panel__file-row" href={file.url} download={file.name}>
                <span>{file.name}</span>
                <span className="simulate-panel__size">{formatSize(file.size)}</span>
              </a>
            ))
          )}
        </div>
      )}
    </div>
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
