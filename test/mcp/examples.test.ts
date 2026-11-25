import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { exampleLibrary, fetchRemoteExample } from '../../src/mcp/examples.js'

setSchemaBundle(localBundle())
afterEach(() => vi.restoreAllMocks())

it('searches and pages the engine-version catalog without downloading models', async () => {
  const load = vi.fn(async () => { throw new Error('search must not load examples') })
  const allIds: string[] = []
  for (let offset = 0; offset < 810; offset += 100) {
    const page = await exampleLibrary({ action: 'search', limit: 100, offset }, load)
    expect(page.total).toBe(810)
    allIds.push(...page.results.map((entry) => entry.id))
  }
  expect(new Set(allIds).size).toBe(810)
  const first = await exampleLibrary({ action: 'search', class: 'Zone', limit: 3 }, load)
  expect(first.total).toBeGreaterThan(100)
  expect(first.results).toHaveLength(3)
  expect(first.truncated).toBe(true)
  expect(first.results.every((entry) => entry.version === ENERGYPLUS_VERSION)).toBe(true)
  const next = await exampleLibrary({ action: 'search', class: 'Zone', limit: 3, offset: 3 }, load)
  expect(next.results.map((entry) => entry.id)).not.toEqual(first.results.map((entry) => entry.id))
  const named = await exampleLibrary({ action: 'search', class: 'Zone', query: '1ZoneUncontrolled', limit: 1 }, load)
  expect(named.results[0]!.id).toBe('1ZoneUncontrolled.idf')
  expect(load).not.toHaveBeenCalled()
})

it('loads only the selected remote example and refuses a different or missing version', async () => {
  const load = vi.fn(async () => 'Version, 26.1; Zone, Example Zone;')
  const result = await exampleLibrary({ action: 'get_objects', example: '1ZoneUncontrolled.idf', class: 'Zone' }, load)
  expect(load).toHaveBeenCalledExactlyOnceWith('1ZoneUncontrolled.idf', false)
  expect(result.results[0]).toMatchObject({ version: ENERGYPLUS_VERSION, source: 'github', total: 1 })
  await expect(exampleLibrary(
    { action: 'get_objects', example: '1ZoneUncontrolled.idf', class: 'Zone' },
    async () => 'Version, 25.2; Zone, Old;',
  )).rejects.toThrow(/declares EnergyPlus 25\.2/)
  await expect(exampleLibrary(
    { action: 'get_objects', example: '1ZoneUncontrolled.idf', class: 'Zone' },
    async () => 'Zone, Missing Version;',
  )).rejects.toThrow(/no version/)
  await expect(exampleLibrary(
    { action: 'get_objects', example: '../../outside.idf', class: 'Zone' }, load,
  )).rejects.toThrow(/Unknown example/)
})

it('keeps bundled examples local and indexes their actual object counts', async () => {
  const text = readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8')
  const load = vi.fn(async () => text)
  const search = await exampleLibrary({ action: 'search', class: 'People', example: '5zone' }, load)
  const detail = await exampleLibrary({ action: 'get_objects', class: 'People', example: '5zone', limit: 1 }, load)
  const found = search.results[0]!
  const inspected = detail.results[0]!
  if (!('matchingObjects' in found) || !('total' in inspected)) throw new Error('Unexpected example result.')
  expect(found.matchingObjects).toBe(inspected.total)
  expect(load).toHaveBeenCalledExactlyOnceWith('5ZoneAirCooled.idf', true)
})

it('fetches a public example from the pinned commit and reports HTTP failures', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Version, 26.1;', { status: 200 }))
  await expect(fetchRemoteExample('1ZoneUncontrolled.idf')).resolves.toBe('Version, 26.1;')
  expect(String(fetch.mock.calls[0]![0])).toBe(
    'https://raw.githubusercontent.com/NatLabRockies/EnergyPlus/6f2e40d10250a105b49966baa24d843711e61048/testfiles/1ZoneUncontrolled.idf',
  )
  await expect(fetchRemoteExample('../outside.idf')).rejects.toThrow(/Unknown example/)
  expect(fetch).toHaveBeenCalledOnce()
  fetch.mockResolvedValue(new Response('', { status: 503 }))
  await expect(fetchRemoteExample('1ZoneUncontrolled.idf')).rejects.toThrow(/HTTP 503/)
})
