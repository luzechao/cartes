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
  /** CPython version inside Pyodide, e.g. "3.14.2". */
  pythonVersion: string
  /** pyenergyplus API version. */
  apiVersion: string
  /** Time to load Pyodide and the engine, in seconds. */
  seconds: number
}

/** Where a line printed by Python code in the REPL came from. `info` is Pyodide's package-loading messages. */
export type OutputStream = 'out' | 'err' | 'info'

/** Result of one REPL submission. */
export interface ExecOutcome {
  ok: boolean
  /** `repr()` of the last expression, when it was not None. */
  value?: string | undefined
  /** Python traceback, for a submission that raised. */
  error?: string | undefined
  seconds: number
}

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'run'; request: SimulationRequest }
  | { id: number; type: 'exec'; code: string }

export type WorkerResponse =
  | { id: number; type: 'init'; info: EngineInfo }
  | { id: number; type: 'run'; outcome: SimulationOutcome }
  | { id: number; type: 'exec'; outcome: ExecOutcome }
  | { id: number; type: 'error'; message: string }
  /** EnergyPlus console output during a simulation. */
  | { type: 'log'; line: string }
  /** Output of a running REPL submission, streamed as it is printed. */
  | { id: number; type: 'output'; stream: OutputStream; line: string }
