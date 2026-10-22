/**
 * Which IDF versions the bundled engine accepts. EnergyPlus applies no transitions, so it only reads models
 * written for its own version. A newer minor version usually runs with a version warning (the corpus is 26.2
 * from EnergyPlus `develop`); anything else should be migrated with IDFVersionUpdater first.
 */
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'

/** "26.1" for EnergyPlus 26.1.0. */
export const ENGINE_IDF_VERSION = ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')

/** A user-facing note when `idfVersion` does not match the engine, or undefined when it does. */
export function versionNote(idfVersion: string | undefined): string | undefined {
  if (!idfVersion) return `The model declares no Version object; the engine reads it as ${ENGINE_IDF_VERSION}.`
  const [major, minor] = idfVersion.split('.').map(Number)
  const [engineMajor, engineMinor] = ENGINE_IDF_VERSION.split('.').map(Number)
  if (major === engineMajor && minor === engineMinor) return undefined
  if (major === engineMajor && minor !== undefined && engineMinor !== undefined && minor > engineMinor) {
    return `The model is version ${idfVersion}; the engine is EnergyPlus ${ENERGYPLUS_VERSION}. It will warn about the version and may reject newer fields.`
  }
  return `The model is version ${idfVersion}; the engine is EnergyPlus ${ENERGYPLUS_VERSION} and applies no transitions. Migrate the file with IDFVersionUpdater first, or expect errors.`
}
