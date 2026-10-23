/**
 * Python REPL state: the transcript, input history and the running flag. Lives in App so the transcript
 * survives switching ribbon tabs. Code runs in the simulation worker's interpreter, queued behind any
 * simulation in progress.
 */
import { useCallback, useRef, useState } from 'react'
import { sharedSimulationClient } from '../simulate/index.js'
import type { Simulation } from './useSimulation.js'

export type EntryKind = 'input' | 'out' | 'err' | 'info' | 'result' | 'error' | 'system'

export interface ReplEntry {
  id: number
  kind: EntryKind
  text: string
}

export interface PythonRepl {
  entries: ReplEntry[]
  running: boolean
  /** Earlier submissions, oldest first. */
  history: string[]
  submit(code: string): Promise<void>
  clear(): void
  restart(): void
}

/** Transcript entries kept; older ones are dropped. */
const MAX_ENTRIES = 2000

export function usePython(simulation: Simulation): PythonRepl {
  const [entries, setEntries] = useState<ReplEntry[]>([])
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const nextId = useRef(1)

  const append = useCallback((kind: EntryKind, text: string) => {
    setEntries((list) => [...list.slice(-(MAX_ENTRIES - 1)), { id: nextId.current++, kind, text }])
  }, [])

  const submit = useCallback(
    async (code: string) => {
      if (!code.trim()) return
      simulation.loadEngine()
      append('input', code)
      setHistory((h) => (h[h.length - 1] === code ? h : [...h, code]))
      setRunning(true)
      try {
        const outcome = await sharedSimulationClient().exec(code, (stream, line) => append(stream, line))
        if (outcome.ok && outcome.value !== undefined) append('result', outcome.value)
        if (!outcome.ok) append('error', outcome.error ?? 'Error')
      } catch (error) {
        append('system', error instanceof Error ? error.message : String(error))
      } finally {
        setRunning(false)
      }
    },
    [append, simulation.loadEngine],
  )

  const clear = useCallback(() => setEntries([]), [])

  const restart = useCallback(() => {
    simulation.restartEngine()
    append('system', 'Restarting Python. Variables, imports and the last run are gone.')
  }, [append, simulation.restartEngine])

  return { entries, running, history, submit, clear, restart }
}
