import Dexie, { type EntityTable } from 'dexie'
import { strToU8, zip } from 'fflate'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import type { SimulationOutcome } from './protocol.js'
import type { ScenarioInput, ScenarioResult } from './scenarios.js'

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

export interface SavedScenario {
  id: number
  batchId: string
  createdAt: string
  modelName: string
  weather: string
  engineVersion: string
  result: ScenarioResult
  outputNames: string[]
  outputBytes: number
}

interface SavedFile {
  id: number
  runId: number
  kind: 'model' | 'output'
  name: string
  bytes: Uint8Array
}

export class ScenarioStore extends Dexie {
  runs!: EntityTable<SavedScenario, 'id'>
  files!: EntityTable<SavedFile, 'id'>

  constructor(name = 'cartes-scenario-results') {
    super(name)
    this.version(1).stores({ runs: '++id, batchId, createdAt', files: '++id, runId, [runId+kind+name]' })
  }

  async retain(
    batch: { id: string; createdAt: string; modelName: string; weather: string },
    scenario: ScenarioInput,
    result: ScenarioResult,
    outcome: SimulationOutcome,
  ): Promise<number> {
    const outputs = Object.entries(outcome.outputs)
    return this.transaction('rw', this.runs, this.files, async () => {
      const runId = await this.runs.add({
        batchId: batch.id, createdAt: batch.createdAt, modelName: batch.modelName, weather: batch.weather,
        engineVersion: ENERGYPLUS_VERSION, result: { ...result, retained: true },
        outputNames: outputs.map(([name]) => name),
        outputBytes: outputs.reduce((total, [, bytes]) => total + bytes.byteLength, 0),
      })
      await this.files.bulkAdd([
        { runId, kind: 'model', name: 'scenario.idf', bytes: strToU8(scenario.idf) },
        ...outputs.map(([name, bytes]) => ({ runId, kind: 'output' as const, name, bytes })),
      ])
      return runId
    })
  }

  async list(): Promise<SavedScenario[]> {
    return this.runs.orderBy('id').reverse().toArray()
  }

  async remove(id: number): Promise<void> {
    await this.transaction('rw', this.runs, this.files, async () => {
      await this.files.where('runId').equals(id).delete()
      await this.runs.delete(id)
    })
  }

  async file(id: number, kind: 'model' | 'output', name: string): Promise<Uint8Array> {
    const file = await this.files.where('[runId+kind+name]').equals([id, kind, name]).first()
    if (!file) throw new Error('The saved file no longer exists.')
    return file.bytes
  }

  async archive(id: number): Promise<Uint8Array> {
    const { run, files } = await this.transaction('r', this.runs, this.files, async () => {
      const run = await this.runs.get(id)
      if (!run) throw new Error('The saved scenario no longer exists.')
      if (run.outputBytes > MAX_ARCHIVE_BYTES) throw new Error('ZIP export is limited to 256 MiB; download individual files instead.')
      return { run, files: await this.files.where('runId').equals(id).toArray() }
    })
    if (files.filter((file) => file.kind === 'model').length !== 1 ||
        files.filter((file) => file.kind === 'output').length !== run.outputNames.length ||
        run.outputNames.some((name) => !files.some((file) => file.kind === 'output' && file.name === name))) {
      throw new Error('The saved scenario is incomplete; its archive cannot be created.')
    }
    const entries: Record<string, Uint8Array> = { 'metadata.json': strToU8(JSON.stringify(run, null, 2)) }
    for (const file of files) {
      if (!file.name || file.name === '.' || file.name === '..' || /[\\/\x00-\x1f]/.test(file.name)) {
        throw new Error(`Cannot safely archive output filename ${JSON.stringify(file.name)}.`)
      }
      const path = `${file.kind === 'model' ? 'model' : 'outputs'}/${file.name}`
      if (Object.hasOwn(entries, path)) throw new Error(`Duplicate archive filename: ${path}`)
      entries[path] = file.bytes
    }
    const total = Object.entries(entries).reduce((sum, [path, bytes]) => sum + bytes.byteLength + strToU8(path).byteLength * 2 + 76, 22)
    if (total > MAX_ARCHIVE_BYTES || files.length >= 65534) {
      throw new Error('ZIP export is limited to 256 MiB; download individual files instead.')
    }
    return new Promise((resolve, reject) => {
      zip(entries, { level: 0 }, (error, bytes) => error ? reject(error) : resolve(bytes))
    })
  }
}

export function scenarioArchiveName(run: SavedScenario): string {
  const name = run.result.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60) || 'scenario'
  return `scenario-${run.id}-${name}.zip`
}

export const scenarioStore = new ScenarioStore()
