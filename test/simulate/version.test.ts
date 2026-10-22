import { describe, expect, it } from 'vitest'
import { ENGINE_IDF_VERSION, versionNote } from '../../src/simulate/version.js'

describe('versionNote', () => {
  it('is silent for the engine version', () => {
    expect(ENGINE_IDF_VERSION).toBe('26.1')
    expect(versionNote('26.1')).toBeUndefined()
  })

  it('warns for a newer minor version, which still runs', () => {
    expect(versionNote('26.2')).toMatch(/warn about the version/)
  })

  it('asks for migration for older versions', () => {
    expect(versionNote('9.4')).toMatch(/IDFVersionUpdater/)
    expect(versionNote('25.2')).toMatch(/IDFVersionUpdater/)
  })

  it('notes a missing Version object', () => {
    expect(versionNote(undefined)).toMatch(/no Version object/)
  })
})
