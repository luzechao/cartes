import { expect, it } from 'vitest'
import { comparisonCharts, runScenarioBatch } from '../../src/simulate/scenarios.js'
import type { SimulationOutcome } from '../../src/simulate/protocol.js'
import type { ResultsDb } from '../../src/results/index.js'

function outcome(success = true): SimulationOutcome {
  return {
    exitCode: success ? 0 : 1,
    summary: { success, raw: success ? 'Completed' : 'Failed', warnings: 0, severe: success ? 0 : 1 },
    messages: success ? [] : [{ severity: 'fatal', message: 'Stopped', details: [] }],
    outputs: { 'eplusout.sql': new Uint8Array([1]) },
    args: [], seconds: 1,
  }
}

it('captures each summary before the next run and builds charts from available data', async () => {
  let current = ''
  const order: string[] = []
  const db: ResultsDb = {
    query: async (sql) => {
      order.push(`query:${current}`)
      if (sql.includes('EnvironmentPeriods')) return { columns: ['EnvironmentName'], rows: [['RUN PERIOD']] }
      return {
        columns: ['TableName', 'RowName', 'ColumnName', 'Units', 'Value'],
        rows: [
          ['Site and Source Energy', 'Total Site Energy', 'Total Energy', 'GJ', current === 'A' ? '1' : '2'],
          ['Building Area', 'Total Building Area', 'Area', 'm2', '100'],
        ],
      }
    },
  }
  const batch = await runScenarioBatch(
    [{ name: 'Baseline', idf: 'A' }, { name: 'Alternative', idf: 'B' }], {},
    async (request) => { current = request.idf; order.push(`run:${current}`); return outcome() }, db,
  )
  expect(order).toEqual(['run:A', 'query:A', 'query:A', 'run:B', 'query:B', 'query:B'])
  expect(batch.scenarios.map((result) => result.results?.siteEnergy?.gj)).toEqual([1, 2])
  expect(comparisonCharts(batch.scenarios)).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Site energy', units: 'kWh', points: [
      { label: 'Baseline', value: 277.8 }, { label: 'Alternative', value: 555.6 },
    ] }),
  ]))
})

it('stops on failed runs and never represents missing summaries as zero', async () => {
  let runs = 0
  const db: ResultsDb = { query: async () => { throw new Error('bad database') } }
  const batch = await runScenarioBatch(
    [{ name: 'A', idf: 'A' }, { name: 'B', idf: 'B' }, { name: 'C', idf: 'C' }], {},
    async () => outcome(++runs === 1), db,
  )
  expect(batch.scenarios).toHaveLength(2)
  expect(batch.scenarios[0]).toMatchObject({ status: 'completed', error: expect.stringContaining('bad database') })
  expect(batch.scenarios[1]).toMatchObject({ status: 'failed', severeAndFatal: [{ message: 'Stopped' }] })
  expect(batch.stopped).toBe(true)
  expect(comparisonCharts(batch.scenarios)).toEqual([])
})

it('stops between runs on cancellation and clears the last outcome if a later run throws', async () => {
  let runs = 0
  const db: ResultsDb = { query: async () => ({ columns: [], rows: [] }) }
  const scenarios = [{ name: 'A', idf: 'A' }, { name: 'B', idf: 'B' }]
  const cancelled = await runScenarioBatch(scenarios, {}, async () => { runs++; return outcome() }, db, () => runs > 0)
  expect(cancelled).toMatchObject({ cancelled: true, stopped: true, scenarios: [{ name: 'A' }] })
  expect(cancelled.lastOutcome).toBeDefined()
  runs = 0
  const failed = await runScenarioBatch(scenarios, {}, async () => {
    if (++runs === 2) throw new Error('runtime failed')
    return outcome()
  }, db)
  expect(failed.scenarios[1]).toMatchObject({ status: 'error', error: 'runtime failed' })
  expect(failed.lastOutcome).toBeUndefined()
})

it('retains each returned outcome, including failures and a run finishing after cancellation', async () => {
  let runs = 0
  const saved: Array<{ name: string; byte: number; status: string }> = []
  const db: ResultsDb = { query: async () => ({ columns: [], rows: [] }) }
  const scenarios = [{ name: 'A', idf: 'A' }, { name: 'B', idf: 'B' }, { name: 'C', idf: 'C' }]
  const retain = async (input: typeof scenarios[number], report: { status: string }, value: SimulationOutcome) => {
    saved.push({ name: input.name, byte: value.outputs['eplusout.sql']![0]!, status: report.status })
  }
  const batch = await runScenarioBatch(scenarios, {}, async () => {
    const result = outcome(++runs === 1)
    result.outputs['eplusout.sql'] = new Uint8Array([runs])
    return result
  }, db, () => false, retain)
  expect(saved).toEqual([{ name: 'A', byte: 1, status: 'completed' }, { name: 'B', byte: 2, status: 'failed' }])
  expect(batch.scenarios.map((result) => result.retained)).toEqual([true, true])
  expect(batch.stopped).toBe(true)

  runs = 0
  saved.length = 0
  const cancelled = await runScenarioBatch(scenarios, {}, async () => { runs++; return outcome() }, db, () => runs > 0, retain)
  expect(cancelled.cancelled).toBe(true)
  expect(saved.map((entry) => entry.name)).toEqual(['A'])
})

it('stops on a retention failure without losing the current outcome or claiming it was saved', async () => {
  let runs = 0
  const batch = await runScenarioBatch(
    [{ name: 'A', idf: 'A' }, { name: 'B', idf: 'B' }], {},
    async () => { runs++; return outcome() },
    { query: async () => ({ columns: [], rows: [] }) },
    () => false, async () => { throw new Error('quota exceeded') },
  )
  expect(runs).toBe(1)
  expect(batch).toMatchObject({
    stopped: true, retentionError: expect.stringContaining('quota exceeded'),
    scenarios: [{ name: 'A', status: 'completed', retained: false }],
    lastOutcome: { outputs: { 'eplusout.sql': new Uint8Array([1]) } },
  })
})
