import { describe, expect, it } from 'vitest'
import { SimulationClient, type WorkerLike } from '../../src/simulate/client.js'
import type { WorkerRequest, WorkerResponse } from '../../src/simulate/protocol.js'

/** A worker that answers each request on the next tick, recording what it was asked. */
class FakeWorker implements WorkerLike {
  readonly requests: WorkerRequest[] = []
  terminated = false
  failRuns = false
  /** Leave exec requests unanswered, like Python stuck in a loop. */
  hangExec = false
  #listeners: ((event: MessageEvent<WorkerResponse>) => void)[] = []

  postMessage(message: WorkerRequest): void {
    this.requests.push(message)
    setTimeout(() => {
      if (message.type === 'init') {
        this.emit({
          id: message.id,
          type: 'init',
          info: { energyPlusVersion: '26.1.0', pyodideVersion: '314.0.7', pythonVersion: '3.14.2', apiVersion: '0.2', seconds: 1 },
        })
      } else if (message.type === 'exec') {
        if (this.hangExec) return
        this.emit({ id: message.id, type: 'output', stream: 'out', line: `ran ${message.code}` })
        this.emit({ id: message.id, type: 'exec', outcome: { ok: true, value: '42', seconds: 0 } })
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

/** A client over fake workers; `workers` lists every worker it created, newest last. */
function fakeClient(): { client: SimulationClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const client = new SimulationClient(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  return { client, workers }
}

const label = (r: WorkerRequest): string => (r.type === 'run' ? r.request.idf : r.type === 'exec' ? `exec:${r.code}` : r.type)

describe('SimulationClient', () => {
  it('initialises once and reuses the engine', async () => {
    const { client, workers } = fakeClient()
    const [a, b] = await Promise.all([client.ready(), client.ready()])
    expect(a.energyPlusVersion).toBe('26.1.0')
    expect(b).toBe(a)
    expect(workers[0]!.requests.filter((r) => r.type === 'init')).toHaveLength(1)
  })

  it('queues runs and REPL input so one is in flight at a time, in order', async () => {
    const { client, workers } = fakeClient()
    const lines: string[] = []
    client.onLog((line) => lines.push(line))
    const output: string[] = []
    await Promise.all([
      client.run({ idf: 'first' }),
      client.exec('x', (stream, line) => output.push(`${stream}:${line}`)),
      client.run({ idf: 'second' }),
    ])
    expect(workers[0]!.requests.map(label)).toEqual(['init', 'first', 'exec:x', 'second'])
    expect(lines).toEqual(['running first', 'running second'])
    expect(output).toEqual(['out:ran x'])
  })

  it('returns the REPL outcome', async () => {
    const { client } = fakeClient()
    await expect(client.exec('6 * 7', () => {})).resolves.toMatchObject({ ok: true, value: '42' })
  })

  it('rejects a failed run without blocking the next one', async () => {
    const { client, workers } = fakeClient()
    workers[0]!.failRuns = true
    await expect(client.run({ idf: 'bad' })).rejects.toThrow('boom')
    workers[0]!.failRuns = false
    await expect(client.run({ idf: 'good' })).resolves.toMatchObject({ exitCode: 0 })
  })

  it('restart replaces a stuck worker, rejects what was waiting, and loads the engine again', async () => {
    const { client, workers } = fakeClient()
    workers[0]!.hangExec = true
    const stuck = client.exec('while True: pass', () => {})
    const queued = client.run({ idf: 'after' })
    await new Promise((r) => setTimeout(r, 5))
    client.restart()
    await expect(stuck).rejects.toThrow('Python was restarted')
    await expect(queued).rejects.toThrow('Python was restarted')
    expect(workers[0]!.terminated).toBe(true)
    expect(workers).toHaveLength(2)
    await expect(client.run({ idf: 'fresh' })).resolves.toMatchObject({ exitCode: 0 })
    expect(workers[1]!.requests.map(label)).toEqual(['init', 'fresh'])
  })

  it('terminates the worker on dispose', () => {
    const { client, workers } = fakeClient()
    client.dispose()
    expect(workers[0]!.terminated).toBe(true)
  })
})
