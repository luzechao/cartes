/**
 * Simulation state shared by the ribbon's Simulate tab (inputs, run, results) and the sidebar's Simulate panel
 * (status, console, messages, files). Lives in App so it survives tab switches and closing the sidebar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { sharedSimulationClient, type EngineInfo, type ScenarioBatchResult, type ScenarioInput, type SimulationOutcome } from '../simulate/index.js'
import { scenarioStore, type SavedScenario } from '../simulate/scenarioStore.js'

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
  savedScenarios: SavedScenario[]
  scenarioStorageError: string | undefined
  runError: string | undefined
  /** EnergyPlus console output of the current or last run. */
  log: string[]
  loadEngine(): void
  /** Replace the worker (and its interpreter) with a fresh one, then load the engine again. */
  restartEngine(): void
  setEpw(file: File | undefined): void
  setPluginFiles(files: File[]): void
  setPackages(packages: string): void
  /** Resolves with the result, or the error that stopped the run; never rejects. */
  run(idf: string, modelName: string, edited: boolean): Promise<RunAttempt>
  /** Run isolated model texts sequentially and retain their outputs in browser storage. */
  runScenarios(scenarios: readonly ScenarioInput[], modelName: string, signal?: AbortSignal): Promise<ScenarioAttempt>
}

export type RunAttempt = { result: SimulationResult; error?: undefined } | { result?: undefined; error: string }
export type ScenarioAttempt = { result: ScenarioBatchResult; error?: undefined } | { result?: undefined; error: string }

export function useSimulation(): Simulation {
  const [engine, setEngine] = useState<EngineStatus>({ state: 'idle' })
  const [epw, setEpw] = useState<File | undefined>(undefined)
  const [pluginFiles, setPluginFiles] = useState<File[]>([])
  const [packages, setPackages] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SimulationResult | undefined>(undefined)
  const [runError, setRunError] = useState<string | undefined>(undefined)
  const [log, setLog] = useState<string[]>([])
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([])
  const [scenarioStorageError, setScenarioStorageError] = useState<string | undefined>()
  const loading = useRef(false)
  const runningRef = useRef(false)

  useEffect(() => {
    const subscription = liveQuery(() => scenarioStore.list()).subscribe({
      next: (runs) => { setSavedScenarios(runs); setScenarioStorageError(undefined) },
      error: (error: unknown) => setScenarioStorageError(error instanceof Error ? error.message : String(error)),
    })
    return () => subscription.unsubscribe()
  }, [])

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
    async (idf: string, modelName: string, edited: boolean): Promise<RunAttempt> => {
      if (runningRef.current) return { error: 'A simulation is already running; wait for it to finish.' }
      runningRef.current = true
      loadEngine()
      setRunning(true)
      setRunError(undefined)
      setResult(undefined)
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
        const result = { ...outcome, modelName, edited }
        setResult(result)
        return { result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setRunError(message)
        return { error: message }
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [epw, pluginFiles, packages, loadEngine],
  )

  const runScenarios = useCallback(
    async (scenarios: readonly ScenarioInput[], modelName: string, signal?: AbortSignal): Promise<ScenarioAttempt> => {
      if (runningRef.current) return { error: 'A simulation is already running; wait for it to finish.' }
      if (pluginFiles.some((file) => file.name.toLowerCase().endsWith('.py'))) {
        return { error: 'Scenario batches do not support Python plugin files; plugin state can persist in the shared interpreter.' }
      }
      runningRef.current = true
      loadEngine()
      setRunning(true)
      setRunError(undefined)
      setResult(undefined)
      setLog([])
      try {
        try {
          await scenarioStore.open()
        } catch (error) {
          throw new Error(`Scenario browser storage is unavailable; no runs were started: ${error instanceof Error ? error.message : String(error)}`)
        }
        const batch = {
          id: crypto.randomUUID(), createdAt: new Date().toISOString(), modelName,
          weather: epw?.name ?? 'none (design days only)',
        }
        const files: Record<string, Uint8Array> = {}
        for (const file of pluginFiles) files[file.name] = new Uint8Array(await file.arrayBuffer())
        const result = await sharedSimulationClient().runScenarios(scenarios, {
          epw: epw ? new Uint8Array(await epw.arrayBuffer()) : undefined,
          files,
          packages: packages.split(',').map((name) => name.trim()).filter(Boolean),
        }, signal, async (scenario, report, outcome) => {
          await scenarioStore.retain(batch, scenario, report, outcome)
        })
        const last = result.scenarios[result.scenarios.length - 1]
        if (result.lastOutcome && last) {
          setResult({ ...result.lastOutcome, modelName: `${modelName} — ${last.name} (scenario)`, edited: true })
        }
        if (result.retentionError) setRunError(result.retentionError)
        else if (last?.status === 'error') setRunError(last.error)
        return { result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setRunError(message)
        return { error: message }
      } finally {
        runningRef.current = false
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
    savedScenarios,
    scenarioStorageError,
    runError,
    log,
    loadEngine,
    restartEngine,
    setEpw,
    setPluginFiles,
    setPackages,
    run,
    runScenarios,
  }
}
