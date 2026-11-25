import { afterEach, expect, it, vi } from 'vitest'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { datasetLibrary, fetchRemoteDataset, planDatasetImport } from '../../src/mcp/datasets.js'
import { ModelSession } from '../../src/mcp/session.js'
import index from '../../src/mcp/dataset-index.json'

setSchemaBundle(localBundle())
afterEach(() => vi.restoreAllMocks())

it('searches and pages the pinned filename catalog without downloading files', async () => {
  const load = vi.fn(async () => { throw new Error('search must not download') })
  const all = await datasetLibrary({ action: 'search', limit: 100 }, load)
  if (!('total' in all) || !('results' in all)) throw new Error('Expected filename search results.')
  expect(all.total).toBe(50)
  expect(all.results?.every((entry) => entry.version === ENERGYPLUS_VERSION)).toBe(true)
  const page = await datasetLibrary({ action: 'search', query: 'window', limit: 2, offset: 2 }, load)
  if (!('total' in page) || !('results' in page)) throw new Error('Expected filename search results.')
  expect(page.total).toBeGreaterThan(2)
  expect(page.results).toHaveLength(2)
  expect(page.scope).toContain(index.commit)
  expect(load).not.toHaveBeenCalled()
})

it('downloads only an indexed file and pages requested objects', async () => {
  const load = vi.fn(async () => 'Material, First; Material, Second; Material, Third;')
  const classes = await datasetLibrary({ action: 'list_classes', dataset: 'Boilers.idf' }, load)
  expect(classes).toMatchObject({ classes: [{ class: 'material', count: 3 }] })
  load.mockClear()
  const result = await datasetLibrary({ action: 'get_objects', dataset: 'Boilers.idf', class: 'Material', limit: 1, offset: 1 }, load)
  expect(load).toHaveBeenCalledExactlyOnceWith('Boilers.idf')
  expect(result).toMatchObject({ file: 'Boilers.idf', total: 3, offset: 1, truncated: true, objects: [{ name: 'Second' }] })
  await expect(datasetLibrary({ action: 'get_objects', dataset: '../outside.idf', class: 'Material' }, load)).rejects.toThrow(/Unknown DataSet/)
  expect(load).toHaveBeenCalledTimes(1)
})

it('plans a named object and its recursive IDD references without editing anything', async () => {
  const load = vi.fn(async () => [
    'Construction, Wall, Brick;',
    'Material, Brick, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;',
    'Material, Unused, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;',
  ].join('\n'))
  const plan = await datasetLibrary({
    action: 'plan_import', dataset: 'Boilers.idf', class: 'Construction', name: 'wall',
  }, load)
  expect(plan).toMatchObject({
    root: { class: 'Construction', name: 'Wall' },
    objects: [
      { class: 'Construction', name: 'Wall' },
      { class: 'Material', name: 'Brick' },
    ],
    references: [{
      from: { class: 'Construction', name: 'Wall' }, field: 'outside_layer',
      referenceLists: ['MaterialName'], name: 'Brick', status: 'included',
    }],
    truncated: false, remaining: 0,
  })

  const missing = await datasetLibrary({
    action: 'plan_import', dataset: 'Boilers.idf', class: 'Construction', name: 'Wall', max_objects: 1,
  }, async () => 'Construction, Wall, External Material;')
  expect(missing).toMatchObject({
    references: [{ name: 'External Material', status: 'not_in_dataset' }],
    objects: [{ name: 'Wall' }], truncated: false,
  })

  const limited = await datasetLibrary({
    action: 'plan_import', dataset: 'Boilers.idf', class: 'Construction', name: 'Wall', max_objects: 1,
  }, async () => 'Construction, Wall, Brick, Brick; Material, Brick, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;')
  expect(limited).toMatchObject({
    references: [{ status: 'limit' }, { status: 'limit' }], truncated: true, remaining: 1, objects: [{ name: 'Wall' }],
  })
})

it('imports a complete plan atomically, reuses identical objects, and undoes the whole import once', async () => {
  const source = [
    'Construction, Wall, Brick;',
    'Material, Brick, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;',
  ].join('\n')
  const plan = await planDatasetImport({
    dataset: 'Boilers.idf', class: 'Construction', name: 'Wall',
  }, async () => source)
  const session = new ModelSession()
  session.openText(`Version, ${ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')};\nMaterial, Brick, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;`)
  await session.prepare()
  const result = session.importDatasetObjects(plan.version, plan.objects.map((object) => ({
    class: object.class, name: object.name,
    fields: object.fields.map(({ index, value }) => ({ index, value })),
  })))
  expect(result).toMatchObject({
    imported: ["Construction 'Wall'"],
    alreadyPresent: ["Material 'Brick'"],
    count: 1,
  })
  expect(session.listObjects('Construction')).toMatchObject({ names: ['Wall'] })
  expect(session.undo()).toEqual({ undid: 'Import DataSet objects' })
  expect(() => session.listObjects('Construction')).toThrow(/No Construction objects/)
})

it('refuses conflicting or unresolved dependencies without partially changing the model', async () => {
  const source = 'Construction, Wall, Brick;\nMaterial, Brick, Rough, 0.1, 0.9, 1000, 800, 0.9, 0.7, 0.7;'
  const plan = await planDatasetImport({
    dataset: 'Boilers.idf', class: 'Construction', name: 'Wall',
  }, async () => source)
  const session = new ModelSession()
  session.openText(`Version, ${ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')};\nMaterial, Brick, Rough, 0.1, 0.9, 900, 800, 0.9, 0.7, 0.7;`)
  await session.prepare()
  const before = session.text()
  const objects = plan.objects.map((object) => ({
    class: object.class, name: object.name,
    fields: object.fields.map(({ index, value }) => ({ index, value })),
  }))
  expect(() => session.importDatasetObjects(plan.version, objects)).toThrow(/already exists with different fields/)
  expect(session.text()).toBe(before)

  const incomplete = await planDatasetImport({
    dataset: 'Boilers.idf', class: 'Construction', name: 'Wall',
  }, async () => 'Construction, Wall, External Material;')
  const empty = new ModelSession()
  empty.openText(`Version, ${ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')};`)
  await empty.prepare()
  const emptyBefore = empty.text()
  expect(() => empty.importDatasetObjects(incomplete.version, incomplete.objects.map((object) => ({
    class: object.class, name: object.name,
    fields: object.fields.map(({ index, value }) => ({ index, value })),
  })))).toThrow(/resolve these IDD references/)
  expect(empty.text()).toBe(emptyBefore)
})

it('refuses a DataSet import from a different EnergyPlus major/minor release', async () => {
  const session = new ModelSession()
  session.openText(`Version, ${ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')};`)
  await session.prepare()
  expect(() => session.importDatasetObjects('25.2.0', [{
    class: 'Material', name: 'Brick', fields: [{ index: 0, value: 'Brick' }],
  }])).toThrow(/open model is/)
  expect(() => session.listObjects('Material')).toThrow(/No Material objects/)
})

it('checks response size and Git blob hash and never fetches unindexed paths', async () => {
  const entry = index.files.find((file) => file.file === 'Boilers.idf')!
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong'))
  await expect(fetchRemoteDataset('../outside.idf')).rejects.toThrow(/Unknown DataSet/)
  expect(fetch).not.toHaveBeenCalled()
  await expect(fetchRemoteDataset(entry.file)).rejects.toThrow(/unexpected size/)
  expect(String(fetch.mock.calls[0]![0])).toContain(`${index.commit}/datasets/Boilers.idf`)
  fetch.mockResolvedValue(new Response(new Uint8Array(entry.size)))
  await expect(fetchRemoteDataset(entry.file)).rejects.toThrow(/does not match/)
  fetch.mockResolvedValue(new Response('', { status: 503 }))
  await expect(fetchRemoteDataset(entry.file)).rejects.toThrow(/HTTP 503/)
})
