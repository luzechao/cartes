/**
 * Web Worker hosting the simulation engine. Simulations are synchronous and can take minutes, so they never
 * run on the UI thread. Assets are served from public/sim-engine/ (copied by `sim-engine-wasm-assets`).
 */
import { fetchAssets } from '@luzechao/sim-engine-wasm'
import { createEngine, type Engine } from './engine.js'
import type { WorkerRequest, WorkerResponse } from './protocol.js'

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  location: { href: string }
}
const scope = self as unknown as WorkerScope

const base = new URL(`${import.meta.env.BASE_URL}sim-engine/`, scope.location.href)
let engine: Promise<Engine> | undefined

function getEngine(): Promise<Engine> {
  engine ??= createEngine({
    indexURL: new URL('pyodide/', base).href,
    readAsset: fetchAssets(new URL('engine/', base)),
    onLog: (line) => scope.postMessage({ type: 'log', line }),
  })
  return engine
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      scope.postMessage({ id: data.id, type: 'init', info: (await getEngine()).info })
    } else {
      const outcome = await (await getEngine()).run(data.request)
      const transfer = Object.values(outcome.outputs).map((bytes) => bytes.buffer as ArrayBuffer)
      scope.postMessage({ id: data.id, type: 'run', outcome }, transfer)
    }
  } catch (error) {
    if (data.type === 'init') engine = undefined
    scope.postMessage({ id: data.id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
