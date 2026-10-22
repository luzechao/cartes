/**
 * The simulation engine: Pyodide + EnergyPlus (@luzechao/sim-engine-wasm), independent of where it runs.
 * The browser uses it from a Web Worker (worker.ts); tests use it directly in Node.
 */
import { loadPyodide } from 'pyodide'
import {
  ENERGYPLUS_VERSION,
  PYODIDE_PACKAGE_BASE_URL,
  installEnergyPlus,
  runEnergyPlus,
  type AssetReader,
} from '@luzechao/sim-engine-wasm'
import type { EngineInfo, SimulationOutcome, SimulationRequest } from './protocol.js'

export interface EngineOptions {
  /** Where Pyodide's runtime files are served. Omit in Node to use the installed `pyodide` package. */
  indexURL?: string | undefined
  /** Reads the engine assets (libenergyplusapi.so, pyenergyplus/*.py). */
  readAsset: AssetReader
  /** EnergyPlus console output, line by line. */
  onLog?: ((line: string) => void) | undefined
}

export interface Engine {
  info: EngineInfo
  run(request: SimulationRequest): Promise<SimulationOutcome>
}

export async function createEngine({ indexURL, readAsset, onLog }: EngineOptions): Promise<Engine> {
  const started = performance.now()
  const log = onLog ?? (() => {})
  const pyodide = await loadPyodide({
    ...(indexURL === undefined ? {} : { indexURL }),
    packageBaseUrl: PYODIDE_PACKAGE_BASE_URL,
    stdout: log,
    stderr: log,
  })
  const apiVersion = await installEnergyPlus(pyodide, readAsset)
  const info: EngineInfo = {
    energyPlusVersion: ENERGYPLUS_VERSION,
    pyodideVersion: pyodide.version,
    apiVersion,
    seconds: (performance.now() - started) / 1000,
  }

  return {
    info,
    async run(request) {
      if (request.packages?.length) {
        const errors: string[] = []
        await pyodide.loadPackage(request.packages, { messageCallback: () => {}, errorCallback: (m) => errors.push(m) })
        if (errors.length) throw new Error(`Could not load ${request.packages.join(', ')}: ${errors.join(' ')}`)
      }
      // Without weather, EnergyPlus can only simulate the model's design days.
      const args = request.epw === undefined ? ['-D'] : []
      const t0 = performance.now()
      const run = runEnergyPlus(pyodide, {
        idf: request.idf,
        epw: request.epw,
        files: request.files,
        extraArgs: args,
      })
      try {
        const outputs: Record<string, Uint8Array> = {}
        for (const name of run.files()) {
          const bytes = run.readBytes(name)
          if (bytes) outputs[name] = bytes
        }
        return {
          exitCode: run.exitCode,
          summary: run.summary,
          messages: run.messages,
          outputs,
          args,
          seconds: (performance.now() - t0) / 1000,
        }
      } finally {
        run.dispose()
      }
    },
  }
}
