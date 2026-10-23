/**
 * UI-thread client for the simulation worker. One worker (Pyodide + EnergyPlus, ~45 MB) is shared by the
 * whole app. Simulations and REPL submissions share one queue, so only one thing runs in it at a time.
 */
import type {
  EngineInfo,
  ExecOutcome,
  OutputStream,
  SimulationOutcome,
  SimulationRequest,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js'

/** The subset of `Worker` the client needs, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  terminate(): void
}

interface Pending {
  resolve: (value: never) => void
  reject: (reason: Error) => void
}

type Call = { type: 'init' } | { type: 'run'; request: SimulationRequest } | { type: 'exec'; code: string }

export class SimulationClient {
  readonly #createWorker: () => WorkerLike
  #worker: WorkerLike
  readonly #pending = new Map<number, Pending>()
  readonly #outputListeners = new Map<number, (stream: OutputStream, line: string) => void>()
  readonly #logListeners = new Set<(line: string) => void>()
  #nextId = 1
  #ready: Promise<EngineInfo> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  /** Bumped by restart(), so work queued before it is cancelled rather than run on the new worker. */
  #generation = 0

  constructor(createWorker: () => WorkerLike) {
    this.#createWorker = createWorker
    this.#worker = this.#attach(createWorker())
  }

  /** Load Pyodide and EnergyPlus in the worker (once). */
  ready(): Promise<EngineInfo> {
    this.#ready ??= this.#call<EngineInfo>({ type: 'init' }).catch((error: unknown) => {
      this.#ready = undefined
      throw error
    })
    return this.#ready
  }

  /** Run one simulation. Calls made while something else runs wait their turn. */
  run(request: SimulationRequest): Promise<SimulationOutcome> {
    return this.#enqueue(() => this.#call<SimulationOutcome>({ type: 'run', request }))
  }

  /** Run Python in the engine's interpreter, streaming what it prints to `onOutput`. */
  exec(code: string, onOutput: (stream: OutputStream, line: string) => void): Promise<ExecOutcome> {
    return this.#enqueue(() => this.#call<ExecOutcome>({ type: 'exec', code }, onOutput))
  }

  /** Subscribe to EnergyPlus console output. Returns an unsubscribe function. */
  onLog(listener: (line: string) => void): () => void {
    this.#logListeners.add(listener)
    return () => this.#logListeners.delete(listener)
  }

  /**
   * Replace the worker with a fresh one: the way out of Python code that never returns. Whatever was running
   * or queued is rejected; the next call loads the engine again.
   */
  restart(): void {
    this.#worker.terminate()
    this.#generation++
    this.#rejectAll(new Error('Python was restarted'))
    this.#ready = undefined
    this.#queue = Promise.resolve()
    this.#worker = this.#attach(this.#createWorker())
  }

  dispose(): void {
    this.#worker.terminate()
    this.#rejectAll(new Error('Simulation client disposed'))
  }

  #attach(worker: WorkerLike): WorkerLike {
    worker.addEventListener('message', ({ data }) => {
      // Messages from a worker that has since been replaced by restart() are dropped.
      if (worker !== this.#worker) return
      if (data.type === 'log') {
        for (const listener of this.#logListeners) listener(data.line)
        return
      }
      if (data.type === 'output') {
        this.#outputListeners.get(data.id)?.(data.stream, data.line)
        return
      }
      const pending = this.#pending.get(data.id)
      if (!pending) return
      this.#pending.delete(data.id)
      this.#outputListeners.delete(data.id)
      if (data.type === 'error') pending.reject(new Error(data.message))
      else pending.resolve((data.type === 'init' ? data.info : data.outcome) as never)
    })
    worker.addEventListener('error', (event) => {
      if (worker !== this.#worker) return
      this.#rejectAll(new Error(event.message || 'The simulation worker failed to start'))
      this.#ready = undefined
    })
    return worker
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const generation = this.#generation
    const result = this.#queue.then(async () => {
      if (generation !== this.#generation) throw new Error('Python was restarted')
      await this.ready()
      return task()
    })
    this.#queue = result.catch(() => undefined)
    return result
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#outputListeners.clear()
  }

  #call<T>(message: Call, onOutput?: (stream: OutputStream, line: string) => void): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: never) => void, reject })
      if (onOutput) this.#outputListeners.set(id, onOutput)
      this.#worker.postMessage({ ...message, id } as WorkerRequest)
    })
  }
}

let shared: SimulationClient | undefined

/** The app-wide client, created on first use. */
export function sharedSimulationClient(): SimulationClient {
  shared ??= new SimulationClient(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }))
  return shared
}
