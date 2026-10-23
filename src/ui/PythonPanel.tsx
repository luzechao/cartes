/**
 * Sidebar Python panel: a REPL in the simulation engine's Pyodide interpreter, the one that runs PythonPlugins.
 * Enter runs the input; Shift+Enter, or Enter after a line ending in ":", starts a new line; ↑/↓ recall history.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Simulation } from './useSimulation.js'
import type { PythonRepl } from './usePython.js'

interface PythonPanelProps {
  simulation: Simulation
  repl: PythonRepl
}

const PROMPT = '>>> '
const CONTINUATION = '... '

export function PythonPanel({ simulation, repl }: PythonPanelProps): React.JSX.Element {
  const { engine } = simulation
  const [input, setInput] = useState('')
  // Position in history while browsing with ↑/↓; history.length means "the line being typed".
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const draft = useRef('')
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    simulation.loadEngine()
  }, [simulation.loadEngine])

  useLayoutEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [repl.entries, repl.running])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    const code = input
    if (!code.trim()) return
    setInput('')
    setCursor(undefined)
    void repl.submit(code)
  }

  const recall = (index: number): void => {
    if (cursor === undefined) draft.current = input
    const value = index >= repl.history.length ? draft.current : repl.history[index]!
    setCursor(index >= repl.history.length ? undefined : index)
    setInput(value)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = event.currentTarget
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const lastLine = input.slice(0, el.selectionStart).split('\n').pop() ?? ''
      if (lastLine.trimEnd().endsWith(':')) {
        // Open a block: new line, indented one level deeper than the current one.
        const indent = (/^\s*/.exec(lastLine)?.[0] ?? '') + '    '
        const at = el.selectionStart
        setInput(input.slice(0, at) + '\n' + indent + input.slice(el.selectionEnd))
        requestAnimationFrame(() => el.setSelectionRange(at + 1 + indent.length, at + 1 + indent.length))
        return
      }
      submit()
    } else if (event.key === 'ArrowUp' && !input.slice(0, el.selectionStart).includes('\n') && repl.history.length > 0) {
      event.preventDefault()
      recall(Math.max(0, (cursor ?? repl.history.length) - 1))
    } else if (event.key === 'ArrowDown' && cursor !== undefined && !input.slice(el.selectionEnd).includes('\n')) {
      event.preventDefault()
      recall(cursor + 1)
    } else if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault()
      repl.clear()
    }
  }

  return (
    <div className="python-panel" onClick={(e) => e.target === e.currentTarget && inputRef.current?.focus()}>
      <div className="python-panel__bar">
        <span className="python-panel__version">
          {engine.state === 'ready'
            ? `Python ${engine.info.pythonVersion} · Pyodide ${engine.info.pyodideVersion}`
            : engine.state === 'error'
              ? 'Python failed to load'
              : 'Loading Python…'}
        </span>
        <span className="spacer" />
        <button type="button" className="python-panel__action" onClick={repl.clear} title="Clear the transcript (Ctrl+L)">
          Clear
        </button>
        <button
          type="button"
          className="python-panel__action"
          onClick={repl.restart}
          title="Start a fresh interpreter: the way out of code that never returns. Variables and the last run are lost."
        >
          Restart
        </button>
      </div>

      <div className="python-panel__transcript" ref={transcriptRef}>
        {repl.entries.length === 0 && (
          <div className="python-panel__welcome">
            <p>
              Python in the simulation environment: the same interpreter that runs PythonPlugins, with EnergyPlus loaded.
            </p>
            <ul>
              <li>
                <code>api</code> is pyenergyplus’s <code>EnergyPlusAPI</code>
              </li>
              <li>
                <code>last_run</code> is the last simulation’s output directory, e.g.{' '}
                <code>open(f"{'{'}last_run{'}'}/eplusout.err").read()</code>
              </li>
              <li>Pyodide packages you import (numpy, pandas, …) are fetched automatically</li>
              <li>
                Top-level <code>await</code> works; code that never returns needs <strong>Restart</strong>
              </li>
            </ul>
          </div>
        )}
        {repl.entries.map((entry) => (
          <pre key={entry.id} className={`python-panel__entry python-panel__entry--${entry.kind}`}>
            {entry.kind === 'input'
              ? entry.text
                  .split('\n')
                  .map((line, i) => (i === 0 ? PROMPT : CONTINUATION) + line)
                  .join('\n')
              : entry.text}
          </pre>
        ))}
        {repl.running && <div className="python-panel__running">Running…</div>}
      </div>

      <div className="python-panel__prompt">
        <span className="python-panel__ps1" aria-hidden="true">
          {PROMPT.trim()}
        </span>
        <textarea
          ref={inputRef}
          className="python-panel__input"
          value={input}
          rows={Math.min(10, input.split('\n').length)}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Python input"
          placeholder={engine.state === 'ready' ? 'Type Python, Enter to run' : 'Python is loading; input will run when it is ready'}
          onChange={(e) => {
            setInput(e.target.value)
            setCursor(undefined)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="python-panel__hint">Enter run · Shift+Enter new line · ↑↓ history · Ctrl+L clear</div>
    </div>
  )
}
