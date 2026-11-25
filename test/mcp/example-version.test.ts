import { expect, it, vi } from 'vitest'

vi.mock('@luzechao/sim-engine-wasm', () => ({ ENERGYPLUS_VERSION: '25.2.0' }))

import { exampleLibrary, fetchRemoteExample } from '../../src/mcp/examples.js'

it('refuses to search or fetch if the index does not match the engine version', async () => {
  const load = vi.fn(async () => '')
  await expect(exampleLibrary({ action: 'search' }, load)).rejects.toThrow(/index is for EnergyPlus 26\.1\.0.*cartes uses 25\.2\.0/)
  await expect(fetchRemoteExample('1ZoneUncontrolled.idf')).rejects.toThrow(/regenerate the index/)
  expect(load).not.toHaveBeenCalled()
})
