import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { expect, it, vi } from 'vitest'
import { ScenarioStore, scenarioArchiveName } from '../../src/simulate/scenarioStore.js'
import type { SimulationOutcome } from '../../src/simulate/protocol.js'

const batch = { id: 'batch-1', createdAt: '2026-01-02T03:04:05.000Z', modelName: 'House.idf', weather: 'weather.epw' }
const outcome: SimulationOutcome = {
  exitCode: 0, summary: { success: true, raw: 'Completed', warnings: 0, severe: 0 }, messages: [],
  outputs: { 'eplusout.sql': new Uint8Array([0, 1, 2]), 'eplusout.err': new Uint8Array([3, 4]) },
  args: [], seconds: 1,
}

it('persists separate scenarios across reopen and exports their exact outputs and model', async () => {
  const store = new ScenarioStore('scenario-store-roundtrip')
  const first = await store.retain(batch, { name: '../Baseline', idf: 'model A' }, { name: '../Baseline', status: 'completed' }, outcome)
  const second = await store.retain({ ...batch, id: 'batch-2' }, { name: '../Baseline', idf: 'model B' },
    { name: '../Baseline', status: 'failed' }, { ...outcome, outputs: { 'eplusout.err': new Uint8Array([8]) } })
  store.close()
  await store.open()
  const runs = await store.list()
  expect(runs.map((run) => run.id)).toEqual([second, first])
  expect(runs[0]).toMatchObject({ batchId: 'batch-2', result: { status: 'failed', retained: true }, outputBytes: 1 })
  expect(scenarioArchiveName(runs[0]!)).toBe(`scenario-${second}-Baseline.zip`)
  const archive = unzipSync(await store.archive(first))
  expect(Object.keys(archive).sort()).toEqual(['metadata.json', 'model/scenario.idf', 'outputs/eplusout.err', 'outputs/eplusout.sql'])
  expect(strFromU8(archive['model/scenario.idf']!)).toBe('model A')
  expect(archive['outputs/eplusout.sql']).toEqual(new Uint8Array([0, 1, 2]))
  expect(archive['outputs/eplusout.err']).toEqual(new Uint8Array([3, 4]))
  expect(await store.file(first, 'output', 'eplusout.sql')).toEqual(new Uint8Array([0, 1, 2]))
  expect(strFromU8(await store.file(first, 'model', 'scenario.idf'))).toBe('model A')
  expect(JSON.parse(strFromU8(archive['metadata.json']!))).toMatchObject({ modelName: 'House.idf', weather: 'weather.epw' })
  const secondArchive = unzipSync(await store.archive(second))
  expect(strFromU8(secondArchive['model/scenario.idf']!)).toBe('model B')
  expect(secondArchive['outputs/eplusout.err']).toEqual(new Uint8Array([8]))
  await store.remove(first)
  expect((await store.list()).map((run) => run.id)).toEqual([second])
  expect(await store.files.where('runId').equals(first).count()).toBe(0)
  await expect(store.archive(first)).rejects.toThrow('no longer exists')
  await expect(store.file(first, 'output', 'eplusout.sql')).rejects.toThrow('no longer exists')
  await store.delete()
})

it('rolls back a storage failure and rejects unsafe archive paths', async () => {
  const store = new ScenarioStore('scenario-store-errors')
  const spy = vi.spyOn(store.files, 'bulkAdd').mockRejectedValueOnce(new Error('quota exceeded'))
  await expect(store.retain(batch, { name: 'A', idf: 'model' }, { name: 'A', status: 'completed' }, outcome))
    .rejects.toThrow('quota exceeded')
  expect(await store.list()).toEqual([])
  spy.mockRestore()
  const id = await store.retain(batch, { name: 'B', idf: 'model' }, { name: 'B', status: 'failed' },
    { ...outcome, outputs: { '../escape': new Uint8Array([1]) } })
  await expect(store.archive(id)).rejects.toThrow('Cannot safely archive')
  await store.runs.update(id, { outputBytes: 256 * 1024 * 1024 + 1 })
  await expect(store.archive(id)).rejects.toThrow('256 MiB')
  expect(await store.file(id, 'output', '../escape')).toEqual(new Uint8Array([1]))
  await store.delete()
})
