/**
 * Runs the real engine (Pyodide + EnergyPlus from @luzechao/sim-engine-wasm) in Node, through the same
 * createEngine() the browser worker uses. Needs the fetched corpus (`npm run fetch-fixtures`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/simulate/engine.js'

const fixture = fileURLToPath(new URL('../fixtures/testfiles/1ZoneUncontrolled.idf', import.meta.url))
const require = createRequire(import.meta.url)
const assets = join(dirname(require.resolve('@luzechao/sim-engine-wasm/package.json')), 'assets')
// Pyodide infers its own location from a stack trace, which vitest's source maps rewrite; point at it explicitly.
const pyodideDir = dirname(require.resolve('pyodide/package.json')) + '/'

// A plugin that publishes a constant through a PythonPlugin output variable, so the ESO proves it ran.
const PLUGIN_OBJECTS = `
PythonPlugin:Instance, Cartes Constant, Yes, cartes_constant, ConstantWriter;
PythonPlugin:Variables, Cartes Variables, CartesValue;
PythonPlugin:OutputVariable, Cartes Value, CartesValue, Averaged, ZoneTimestep, C;
Output:Variable, Cartes Value, PythonPlugin:OutputVariable, Timestep;
`
const PLUGIN_MODULE = `
from pyenergyplus.plugin import EnergyPlusPlugin

class ConstantWriter(EnergyPlusPlugin):
    def on_end_of_zone_timestep_before_zone_reporting(self, state) -> int:
        handle = self.api.exchange.get_global_handle(state, "CartesValue")
        self.api.exchange.set_global_value(state, handle, 42.0)
        return 0
`

describe.skipIf(!existsSync(fixture))('simulation engine (Node)', () => {
  it('simulates design days and runs a PythonPlugin', { timeout: 180_000 }, async () => {
    const engine = await createEngine({ indexURL: pyodideDir, readAsset: (name) => readFile(join(assets, name)) })
    expect(engine.info.energyPlusVersion).toBe('26.1.0')

    const idf = readFileSync(fixture, 'utf8') + PLUGIN_OBJECTS
    const outcome = await engine.run({
      idf,
      files: { 'cartes_constant.py': new TextEncoder().encode(PLUGIN_MODULE) },
    })

    expect(outcome.args).toEqual(['-D'])
    expect(outcome.exitCode).toBe(0)
    expect(outcome.summary?.success).toBe(true)
    expect(outcome.summary?.severe).toBe(0)

    const eso = new TextDecoder().decode(outcome.outputs['eplusout.eso'])
    const header = eso.split('\n').find((line) => /,CARTES VALUE,PythonPlugin:OutputVariable/i.test(line))
    expect(header).toBeDefined()
    const id = header!.split(',')[0]
    const values = eso
      .split('\n')
      .filter((line) => line.startsWith(`${id},`) && line !== header)
      .map((line) => Number(line.split(',')[1]))
    expect(values.length).toBeGreaterThan(0)
    expect(new Set(values)).toEqual(new Set([42]))
  })
})
