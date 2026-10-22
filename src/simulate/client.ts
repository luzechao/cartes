/**
 * UI-thread client for the simulation worker. One worker (Pyodide + EnergyPlus, ~45 MB) is shared by the
 * whole app; runs are queued so only one simulation is in flight at a time.
 */
import type { EngineInfo, SimulationOutcome, SimulationRequest, WorkerRequest, WorkerResponse } from './protocol.js'

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

export class SimulationClient {
  readonly #worker: WorkerLike
  readonly #pending = new Map<number, Pending>()
  readonly #logListeners = new Set<(line: string) => void>()
  #nextId = 1
  #ready: Promise<EngineInfo> | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(worker: WorkerLike) {
    this.#worker = worker
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'log') {
        for (const listener of this.#logListeners) listener(data.line)
        return
      }
      const pending = this.#pending.get(data.id)
      if (!pending) return
      this.#pending.delete(data.id)
      if (data.type === 'error') pending.reject(new Error(data.message))
      else pending.resolve((data.type === 'init' ? data.info : data.outcome) as never)
    })
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The simulation worker failed to start')
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
      this.#ready = undefined
    })
  }

  /** Load Pyodide and EnergyPlus in the worker (once). */
  ready(): Promise<EngineInfo> {
    this.#ready ??= this.#call<EngineInfo>({ type: 'init' }).catch((error: unknown) => {
      this.#ready = undefined
      throw error
    })
    return this.#ready
  }

  /** Run one simulation. Calls made while another run is in flight wait their turn. */
  run(request: SimulationRequest): Promise<SimulationOutcome> {
    const result = this.#queue.then(async () => {
      await this.ready()
      return this.#call<SimulationOutcome>({ type: 'run', request })
    })
    this.#queue = result.catch(() => undefined)
    return result
  }

  /** Subscribe to EnergyPlus console output. Returns an unsubscribe function. */
  onLog(listener: (line: string) => void): () => void {
    this.#logListeners.add(listener)
    return () => this.#logListeners.delete(listener)
  }

  dispose(): void {
    this.#worker.terminate()
    const error = new Error('Simulation client disposed')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #call<T>(message: { type: 'init' } | { type: 'run'; request: SimulationRequest }): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: never) => void, reject })
      this.#worker.postMessage({ ...message, id } as WorkerRequest)
    })
  }
}

let shared: SimulationClient | undefined

/** The app-wide client, created on first use. */
export function sharedSimulationClient(): SimulationClient {
  shared ??= new SimulationClient(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }))
  return shared
}
