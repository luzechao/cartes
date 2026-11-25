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
import { localBundle } from '@idfkit/schemas/node'
import { createEngine } from '../../src/simulate/engine.js'
import { runScenarioBatch } from '../../src/simulate/scenarios.js'
import { seriesChart, timeseries, withResultOutputs } from '../../src/results/index.js'
import { queryOverPython } from '../../src/results/python.js'
import { ModelSession } from '../../src/mcp/session.js'
import { setSchemaBundle } from '../../src/schema/index.js'
import 'fake-indexeddb/auto'
import { unzipSync, strFromU8 } from 'fflate'
import { ScenarioStore } from '../../src/simulate/scenarioStore.js'

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
    const logLines: string[] = []
    const engine = await createEngine({
      indexURL: pyodideDir,
      readAsset: (name) => readFile(join(assets, name)),
      onLog: (line) => logLines.push(line),
    })
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

    // The REPL runs in the same interpreter, after the run.
    const repl = async (code: string): Promise<{ outcome: Awaited<ReturnType<typeof engine.exec>>; out: string[] }> => {
      const out: string[] = []
      const result = await engine.exec(code, (stream, line) => out.push(`${stream}:${line}`))
      return { outcome: result, out }
    }

    const printed = await repl('print("a"); print("b", end="")\n6 * 7')
    expect(printed.outcome).toMatchObject({ ok: true, value: '42' })
    expect(printed.out).toEqual(['out:a', 'out:b'])

    expect((await repl('x = 5')).outcome).toMatchObject({ ok: true, value: undefined })
    expect((await repl('x + 1')).outcome).toMatchObject({ ok: true, value: '6' })

    const failed = await repl('def f():\n    return 1 / 0\nf()')
    expect(failed.outcome.ok).toBe(false)
    expect(failed.outcome.error).toMatch(/^Traceback[\s\S]*File "<python>", line 3[\s\S]*ZeroDivisionError: division by zero$/)
    expect(failed.outcome.error).not.toMatch(/_pyodide|eval_code_async/)

    const syntax = await repl('def broken(:')
    expect(syntax.outcome.error).toMatch(/SyntaxError/)

    const env = await repl(
      'import os\n(type(api).__name__, sorted(f for f in os.listdir(last_run) if f in ("eplusout.err", "eplusout.eso")))',
    )
    expect(env.outcome.value).toBe("('EnergyPlusAPI', ['eplusout.err', 'eplusout.eso'])")

    expect((await repl('import asyncio\nawait asyncio.sleep(0)\n"awaited"')).outcome.value).toBe("'awaited'")

    // The run's console output went to the simulation log, and REPL output did not.
    expect(logLines).toContain('EnergyPlus Completed Successfully.')
    expect(logLines).not.toContain('a')

    setSchemaBundle(localBundle())
    const model = new ModelSession()
    model.openText(readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8'))
    await model.prepare()
    model.setSimulationSettings({ runPeriod: { beginMonth: 1, beginDay: 1, endMonth: 1, endDay: 3 } })
    const baseline = withResultOutputs(model.text()).idf
    model.setParameter('fan_efficiency', 'Supply Fan 1', 0.3)
    const alternative = withResultOutputs(model.text()).idf
    const epw = readFileSync('public/examples/USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw')
    const db = { query: (sql: string, params: Array<string | number | null> = []) => queryOverPython(async (code) => {
      let stdout = ''
      const result = await engine.exec(code, (stream, line) => { if (stream === 'out') stdout += `${line}\n` })
      return { ...result, stdout }
    }, sql, params) }
    const saved = new ScenarioStore('real-engine-scenarios')
    const batch = await runScenarioBatch(
      [{ name: 'Baseline', idf: baseline }, { name: 'Lower fan efficiency', idf: alternative }],
      { epw },
      (request) => engine.run(request),
      db,
      () => false,
      async (input, report, outcome) => {
        await saved.retain({ id: 'real-batch', createdAt: new Date().toISOString(), modelName: '5ZoneAirCooled.idf',
          weather: 'Chicago.epw' }, input, report, outcome)
      },
    )
    expect(batch.scenarios.map((scenario) => scenario.status)).toEqual(['completed', 'completed'])
    expect(batch.scenarios[0]!.results?.siteEnergy?.kwh).toBeGreaterThan(0)
    expect(batch.scenarios[1]!.results?.siteEnergy?.kwh).toBeGreaterThan(batch.scenarios[0]!.results!.siteEnergy!.kwh)
    const savedRuns = await saved.list()
    expect(savedRuns).toHaveLength(2)
    for (const [run, idf] of [[savedRuns[1]!, baseline], [savedRuns[0]!, alternative]] as const) {
      const archive = unzipSync(await saved.archive(run.id))
      expect(strFromU8(archive['model/scenario.idf']!)).toBe(idf)
      expect(archive['outputs/eplusout.sql']?.byteLength).toBeGreaterThan(0)
      expect(archive['outputs/eplusout.err']?.byteLength).toBeGreaterThan(0)
      expect(Object.keys(archive).filter((name) => name.startsWith('outputs/'))).toHaveLength(run.outputNames.length)
    }
    await saved.delete()
    const series = await timeseries(db, { name: 'Site Outdoor Air Drybulb Temperature', frequency: 'Hourly' })
    expect(series).toHaveLength(1)
    expect(series[0]!.count).toBe(72)
    expect(seriesChart(series[0]!).chart.points).toHaveLength(1)
    await expect(engine.run({ idf: baseline, files: { 'missing-directory/input.txt': new Uint8Array([1]) } })).rejects.toThrow()
    expect((await repl('last_run is None')).outcome.value).toBe('True')
  })
})
