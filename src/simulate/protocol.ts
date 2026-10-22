/**
 * Messages between the UI thread and the simulation worker (src/simulate/worker.ts).
 */
import type { EndSummary, ErrMessage } from '@luzechao/sim-engine-wasm'

export interface SimulationRequest {
  /** IDF text to simulate (the current, possibly edited, model). */
  idf: string
  /** EPW weather file. Without one, only the model's design days are simulated (`-D`). */
  epw?: Uint8Array | undefined
  /** Extra files for the run directory, e.g. PythonPlugin modules (`MyPlugin.py`). */
  files?: Record<string, Uint8Array> | undefined
  /** Pyodide packages to load before running, e.g. `['numpy']` for plugins that import it. */
  packages?: string[] | undefined
}

export interface SimulationOutcome {
  /** EnergyPlus return code; 0 means it completed. */
  exitCode: number
  /** Parsed `eplusout.end`. Absent if EnergyPlus stopped before writing it. */
  summary: EndSummary | undefined
  /** Warnings, severe errors and fatal errors from `eplusout.err`. */
  messages: ErrMessage[]
  /** Every output file, by name (`eplusout.err`, `eplustbl.htm`, ...). */
  outputs: Record<string, Uint8Array>
  /** EnergyPlus command-line arguments used, excluding paths. */
  args: string[]
  /** Wall time of the run, in seconds. */
  seconds: number
}

export interface EngineInfo {
  energyPlusVersion: string
  pyodideVersion: string
  /** pyenergyplus API version. */
  apiVersion: string
  /** Time to load Pyodide and the engine, in seconds. */
  seconds: number
}

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'run'; request: SimulationRequest }

export type WorkerResponse =
  | { id: number; type: 'init'; info: EngineInfo }
  | { id: number; type: 'run'; outcome: SimulationOutcome }
  | { id: number; type: 'error'; message: string }
  | { type: 'log'; line: string }
