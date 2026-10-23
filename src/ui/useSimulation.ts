/**
 * Simulation state shared by the ribbon's Simulate tab (inputs, run, results) and the sidebar's Simulate panel
 * (status, console, messages, files). Lives in App so it survives tab switches and closing the sidebar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sharedSimulationClient, type EngineInfo, type SimulationOutcome } from '../simulate/index.js'

/** Console lines kept; an annual run prints a few hundred. */
const LOG_LINES = 5000

// Outputs worth offering first; everything else follows alphabetically.
const PREFERRED_OUTPUTS = ['eplustbl.htm', 'eplusout.err', 'eplusout.csv', 'eplusout.eso', 'eplusout.sql']

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; info: EngineInfo }
  | { state: 'error'; message: string }

export interface SimulationResult extends SimulationOutcome {
  /** Name of the model file that was simulated. */
  modelName: string
  /** Whether the model had unsaved edits when it was simulated. */
  edited: boolean
}

export interface OutputFile {
  name: string
  size: number
  /** Object URL; revoked when the next result replaces this one. */
  url: string
}

export interface Simulation {
  engine: EngineStatus
  epw: File | undefined
  pluginFiles: File[]
  /** Comma-separated Pyodide package names, e.g. "numpy". */
  packages: string
  running: boolean
  result: SimulationResult | undefined
  /** The last result's output files, preferred ones first. */
  outputs: OutputFile[]
  runError: string | undefined
  /** EnergyPlus console output of the current or last run. */
  log: string[]
  loadEngine(): void
  /** Replace the worker (and its interpreter) with a fresh one, then load the engine again. */
  restartEngine(): void
  setEpw(file: File | undefined): void
  setPluginFiles(files: File[]): void
  setPackages(packages: string): void
  run(idf: string, modelName: string, edited: boolean): Promise<void>
}

export function useSimulation(): Simulation {
  const [engine, setEngine] = useState<EngineStatus>({ state: 'idle' })
  const [epw, setEpw] = useState<File | undefined>(undefined)
  const [pluginFiles, setPluginFiles] = useState<File[]>([])
  const [packages, setPackages] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SimulationResult | undefined>(undefined)
  const [runError, setRunError] = useState<string | undefined>(undefined)
  const [log, setLog] = useState<string[]>([])
  const loading = useRef(false)

  // Subscribing creates the worker, so wait until the engine has been asked for.
  const engineStarted = engine.state !== 'idle'
  useEffect(() => {
    if (!engineStarted) return
    return sharedSimulationClient().onLog((line) => setLog((lines) => [...lines.slice(-(LOG_LINES - 1)), line]))
  }, [engineStarted])

  const outputs = useMemo<OutputFile[]>(() => {
    if (!result) return []
    const rank = (name: string): number => {
      const i = PREFERRED_OUTPUTS.indexOf(name)
      return i < 0 ? PREFERRED_OUTPUTS.length : i
    }
    return Object.keys(result.outputs)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((name) => {
        const bytes = result.outputs[name]!
        const type = name.endsWith('.htm') ? 'text/html' : 'application/octet-stream'
        return { name, size: bytes.byteLength, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })) }
      })
  }, [result])
  useEffect(() => () => outputs.forEach((file) => URL.revokeObjectURL(file.url)), [outputs])

  const loadEngine = useCallback(() => {
    if (loading.current) return
    loading.current = true
    setEngine({ state: 'loading' })
    sharedSimulationClient()
      .ready()
      .then((info) => setEngine({ state: 'ready', info }))
      .catch((error: unknown) => {
        loading.current = false
        setEngine({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [])

  const restartEngine = useCallback(() => {
    sharedSimulationClient().restart()
    loading.current = false
    loadEngine()
  }, [loadEngine])

  const run = useCallback(
    async (idf: string, modelName: string, edited: boolean) => {
      loadEngine()
      setRunning(true)
      setRunError(undefined)
      setLog([])
      try {
        const files: Record<string, Uint8Array> = {}
        for (const file of pluginFiles) files[file.name] = new Uint8Array(await file.arrayBuffer())
        const outcome = await sharedSimulationClient().run({
          idf,
          epw: epw ? new Uint8Array(await epw.arrayBuffer()) : undefined,
          files,
          packages: packages
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
        })
        setResult({ ...outcome, modelName, edited })
      } catch (error) {
        setRunError(error instanceof Error ? error.message : String(error))
      } finally {
        setRunning(false)
      }
    },
    [epw, pluginFiles, packages, loadEngine],
  )

  return {
    engine,
    epw,
    pluginFiles,
    packages,
    running,
    result,
    outputs,
    runError,
    log,
    loadEngine,
    restartEngine,
    setEpw,
    setPluginFiles,
    setPackages,
    run,
  }
}
