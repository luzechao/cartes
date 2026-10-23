/**
 * The simulation engine: Pyodide + EnergyPlus (@luzechao/sim-engine-wasm), independent of where it runs.
 * The browser uses it from a Web Worker (worker.ts); tests use it directly in Node.
 *
 * The same interpreter serves three purposes: it hosts EnergyPlus, it runs PythonPlugin classes during a
 * simulation, and it backs the Python REPL (`exec`). REPL code runs in its own namespace, `_cartes_ns`, which
 * starts with `api` (pyenergyplus's EnergyPlusAPI) and `last_run` (the last simulation's output directory).
 */
import { loadPyodide } from 'pyodide'
import {
  ENERGYPLUS_VERSION,
  PYODIDE_PACKAGE_BASE_URL,
  installEnergyPlus,
  runEnergyPlus,
  type AssetReader,
  type RunResult,
} from '@luzechao/sim-engine-wasm'
import type { EngineInfo, ExecOutcome, OutputStream, SimulationOutcome, SimulationRequest } from './protocol.js'

export interface EngineOptions {
  /** Where Pyodide's runtime files are served. Omit in Node to use the installed `pyodide` package. */
  indexURL?: string | undefined
  /** Reads the engine assets (libenergyplusapi.so, pyenergyplus/*.py). */
  readAsset: AssetReader
  /** EnergyPlus console output, line by line. */
  onLog?: ((line: string) => void) | undefined
}

export type OutputListener = (stream: OutputStream, line: string) => void

export interface Engine {
  info: EngineInfo
  run(request: SimulationRequest): Promise<SimulationOutcome>
  /** Run REPL input: statements, then the value of a final expression. Top-level `await` is allowed. */
  exec(code: string, onOutput: OutputListener): Promise<ExecOutcome>
}

// `eval_code_async` compiles with top-level await and returns the last expression's value. Tracebacks are cut
// to the frames of the submitted code, so they do not start with Pyodide's own machinery.
const REPL_SETUP = `
import sys as _cartes_sys

_cartes_ns = {"__name__": "__main__", "api": _ep_api, "last_run": None}

async def _cartes_repl(source):
    import traceback
    from pyodide.code import eval_code_async
    try:
        value = await eval_code_async(source, _cartes_ns, filename="<python>")
    except BaseException as error:
        tb = error.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<python>":
            tb = tb.tb_next
        return False, "".join(traceback.format_exception(type(error), error, tb)).rstrip()
    finally:
        _cartes_sys.stdout.flush()
        _cartes_sys.stderr.flush()
    return True, None if value is None else repr(value)
`

/**
 * A Pyodide stdout/stderr writer that emits whole lines. Unlike Pyodide's batched mode, a trailing partial line
 * can be flushed on demand.
 */
function lineWriter(emit: (line: string) => void): { write(buffer: Uint8Array): number; flush(): void } {
  const decoder = new TextDecoder()
  let pending = ''
  return {
    write(buffer) {
      pending += decoder.decode(buffer, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
      }
      return buffer.length
    },
    flush() {
      if (pending) emit(pending)
      pending = ''
    },
  }
}

interface PyProxyLike {
  toJs(): unknown
  destroy(): void
}

export async function createEngine({ indexURL, readAsset, onLog }: EngineOptions): Promise<Engine> {
  const started = performance.now()
  const log = onLog ?? (() => {})
  // Python output goes to the simulation console, except while REPL input runs.
  const toLog: OutputListener = (_stream, line) => log(line)
  let sink: OutputListener = toLog
  const stdout = lineWriter((line) => sink('out', line))
  const stderr = lineWriter((line) => sink('err', line))
  const pyodide = await loadPyodide({
    ...(indexURL === undefined ? {} : { indexURL }),
    packageBaseUrl: PYODIDE_PACKAGE_BASE_URL,
  })
  pyodide.setStdout(stdout)
  pyodide.setStderr(stderr)
  const apiVersion = await installEnergyPlus(pyodide, readAsset)
  pyodide.runPython(REPL_SETUP)
  const repl = pyodide.globals.get('_cartes_repl') as (code: string) => Promise<PyProxyLike>
  const info: EngineInfo = {
    energyPlusVersion: ENERGYPLUS_VERSION,
    pyodideVersion: pyodide.version,
    pythonVersion: String(pyodide.runPython('_cartes_sys.version.split()[0]')),
    apiVersion,
    seconds: (performance.now() - started) / 1000,
  }

  // The last run's outputs stay in Pyodide's file system, for the REPL's `last_run`, until the next run.
  let lastRun: RunResult | undefined

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
      lastRun?.dispose()
      lastRun = undefined
      const t0 = performance.now()
      const run = runEnergyPlus(pyodide, {
        idf: request.idf,
        epw: request.epw,
        files: request.files,
        extraArgs: args,
      })
      lastRun = run
      stdout.flush()
      stderr.flush()
      pyodide.runPython(`_cartes_ns["last_run"] = ${JSON.stringify(run.outputDir)}`)
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
    },

    async exec(code, onOutput) {
      const t0 = performance.now()
      sink = onOutput
      try {
        try {
          // Fetch Pyodide packages the code imports (numpy, pandas, ...) before running it.
          await pyodide.loadPackagesFromImports(code, {
            messageCallback: (m) => onOutput('info', m),
            errorCallback: (m) => onOutput('err', m),
          })
        } catch {
          // Unparseable code: running it reports the SyntaxError properly.
        }
        const proxy = await repl(code)
        const [ok, text] = proxy.toJs() as [boolean, string | null]
        proxy.destroy()
        const seconds = (performance.now() - t0) / 1000
        return ok ? { ok, value: text ?? undefined, seconds } : { ok, error: text ?? 'Error', seconds }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), seconds: (performance.now() - t0) / 1000 }
      } finally {
        // A last line without a newline, e.g. print(x, end=""), belongs to this submission.
        stdout.flush()
        stderr.flush()
        sink = toLog
      }
    },
  }
}
