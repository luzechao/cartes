import { describe, expect, it } from 'vitest'
import { SimulationClient, type WorkerLike } from '../../src/simulate/client.js'
import type { WorkerRequest, WorkerResponse } from '../../src/simulate/protocol.js'

/** A worker that answers each request on the next tick, recording what it was asked. */
class FakeWorker implements WorkerLike {
  readonly requests: WorkerRequest[] = []
  terminated = false
  failRuns = false
  #listeners: ((event: MessageEvent<WorkerResponse>) => void)[] = []

  postMessage(message: WorkerRequest): void {
    this.requests.push(message)
    setTimeout(() => {
      if (message.type === 'init') {
        this.emit({ id: message.id, type: 'init', info: { energyPlusVersion: '26.1.0', pyodideVersion: '314.0.7', apiVersion: '0.2', seconds: 1 } })
      } else if (this.failRuns) {
        this.emit({ id: message.id, type: 'error', message: 'boom' })
      } else {
        this.emit({ type: 'log', line: `running ${message.request.idf}` })
        this.emit({
          id: message.id,
          type: 'run',
          outcome: { exitCode: 0, summary: undefined, messages: [], outputs: {}, args: [], seconds: 0 },
        })
      }
    }, 0)
  }

  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    if (type === 'message') this.#listeners.push(listener as (event: MessageEvent<WorkerResponse>) => void)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: WorkerResponse): void {
    for (const listener of this.#listeners) listener({ data } as MessageEvent<WorkerResponse>)
  }
}

describe('SimulationClient', () => {
  it('initialises once and reuses the engine', async () => {
    const worker = new FakeWorker()
    const client = new SimulationClient(worker)
    const [a, b] = await Promise.all([client.ready(), client.ready()])
    expect(a.energyPlusVersion).toBe('26.1.0')
    expect(b).toBe(a)
    expect(worker.requests.filter((r) => r.type === 'init')).toHaveLength(1)
  })

  it('queues runs so one is in flight at a time, in order', async () => {
    const worker = new FakeWorker()
    const client = new SimulationClient(worker)
    const lines: string[] = []
    client.onLog((line) => lines.push(line))
    await Promise.all([client.run({ idf: 'first' }), client.run({ idf: 'second' })])
    expect(worker.requests.map((r) => (r.type === 'run' ? r.request.idf : r.type))).toEqual(['init', 'first', 'second'])
    expect(lines).toEqual(['running first', 'running second'])
  })

  it('rejects a failed run without blocking the next one', async () => {
    const worker = new FakeWorker()
    const client = new SimulationClient(worker)
    worker.failRuns = true
    await expect(client.run({ idf: 'bad' })).rejects.toThrow('boom')
    worker.failRuns = false
    await expect(client.run({ idf: 'good' })).resolves.toMatchObject({ exitCode: 0 })
  })

  it('terminates the worker on dispose', () => {
    const worker = new FakeWorker()
    new SimulationClient(worker).dispose()
    expect(worker.terminated).toBe(true)
  })
})
