import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { localBundle } from '@idfkit/schemas/node'
import {
  filterOutputs,
  listReports,
  parseDictionary,
  querySql,
  reportedVariables,
  reportTable,
  resultsSummary,
  timeseries,
  withResultOutputs,
  type ResultsDb,
} from '../../src/results/index.js'
import { queryOverPython } from '../../src/results/python.js'
import { setSchemaBundle } from '../../src/schema/index.js'
import { ModelSession } from '../../src/mcp/session.js'
import { resolveEnergyPlus } from '../harness/energyplus.js'

setSchemaBundle(localBundle())

const EXAMPLE = readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8')
const EPW = join(import.meta.dirname, '../../public/examples/USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw')

describe('output dictionaries and requests', () => {
  it('reads both .rdd layouts', () => {
    const regular = 'Program Version,EnergyPlus\nVar Type (reported time step),Var Report Type,Variable Name [Units]\nZone,Average,Zone Air Temperature [C]\nHVAC,Sum,Fan Electricity Energy [J]\n'
    const idf = '! Program Version\nOutput:Variable,*,Zone Air Temperature,hourly; !- Zone Average [C]\nOutput:Meter,Electricity:Facility,hourly; !- Zone Meter [J]\n'
    expect(parseDictionary(regular)).toEqual([
      { name: 'Zone Air Temperature', units: 'C', kind: 'Zone', type: 'Average' },
      { name: 'Fan Electricity Energy', units: 'J', kind: 'HVAC', type: 'Sum' },
    ])
    expect(parseDictionary(idf)).toEqual([
      { name: 'Zone Air Temperature', units: 'C', kind: 'Zone', type: 'Average' },
      { name: 'Electricity:Facility', units: 'J', kind: 'Zone', type: 'Meter' },
    ])
    expect(filterOutputs(parseDictionary(regular), 'fan energy').matches.map((o) => o.name)).toEqual(['Fan Electricity Energy'])
  })

  it('asks for SQLite, the dictionary and summary reports only where the model has none', () => {
    expect(withResultOutputs(EXAMPLE).added).toEqual(['Output:SQLite'])
    const bare = 'Version,26.1;\n'
    const r = withResultOutputs(bare)
    expect(r.added).toEqual(['Output:SQLite', 'Output:VariableDictionary', 'Output:Table:SummaryReports'])
    expect(withResultOutputs(r.idf).added).toEqual([])
  })
})

const exe = resolveEnergyPlus()

describe.skipIf(!exe)('results of a real run (EnergyPlus, January in Chicago)', () => {
  const dir = join(import.meta.dirname, '../../.eplus-tmp/results-test')
  let db: ResultsDb
  let rdd: string

  beforeAll(async () => {
    const s = new ModelSession()
    s.openText(EXAMPLE, '5ZoneAirCooled.idf')
    await s.prepare()
    s.setSimulationSettings({ runPeriod: { beginMonth: 1, beginDay: 1, endMonth: 1, endDay: 31 } })
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'in.idf'), withResultOutputs(s.text()).idf)
    execFileSync(exe!, ['-w', EPW, '-d', dir, join(dir, 'in.idf')], { stdio: 'pipe', timeout: 120_000 })
    rdd = readFileSync(join(dir, 'eplusout.rdd'), 'utf8')
    const { DatabaseSync } = await import('node:sqlite')
    const sqlite = new DatabaseSync(join(dir, 'eplusout.sql'), { readOnly: true })
    db = {
      query: async (sql, params = []) => {
        const stmt = sqlite.prepare(sql)
        const columns = stmt.columns().map((c) => c.name)
        const rows = stmt.all(...(params as Array<string | number | null>)).map((r) => columns.map((c) => (r as Record<string, string | number | null>)[c] ?? null))
        return { columns, rows }
      },
    }
  }, 150_000)

  it('summarizes energy, end uses and unmet hours', async () => {
    const r = await resultsSummary(db)
    expect(r.environments).toContain('RUN PERIOD 1')
    expect(r.building?.totalAreaM2).toBeCloseTo(927.2, 1)
    expect(r.siteEnergy!.kwh).toBeGreaterThan(5000)
    expect(r.siteEnergy!.kwhPerM2).toBeCloseTo(r.siteEnergy!.kwh / 927.2, 1)
    expect(r.endUses!.map((e) => `${e.endUse}/${e.fuel}`)).toEqual(expect.arrayContaining(['Interior Lighting/Electricity', 'Heating/Natural Gas']))
    expect(r.totalsByFuel!.every((t) => t.units === 'kWh')).toBe(true)
    expect(r.unmetHours).toBeDefined()
  })

  it('lists and reads tabular reports', async () => {
    const reports = await listReports(db, 'envelope')
    expect(reports.map((r) => r.report)).toContain('EnvelopeSummary')
    const t = await reportTable(db, 'envelopesummary', 'Opaque Exterior')
    expect(t.columns).toEqual(expect.arrayContaining(['Construction', 'U-Factor with Film [W/m2-K]']))
    expect(t.rows.find((r) => r.row === 'FRONT-1')?.values[0]).toBe('WALL-1')
    await expect(reportTable(db, 'EnvelopeSummary', 'No Such Table')).rejects.toThrow(/list_report_tables/)
  })

  it('summarizes time series in SQL', async () => {
    const vars = await reportedVariables(db, 'outdoor drybulb')
    expect(vars[0]).toMatchObject({ name: 'Site Outdoor Air Drybulb Temperature', units: 'C', meter: false })
    const [t] = await timeseries(db, { name: 'site outdoor air drybulb temperature' })
    expect(t!.count).toBe(31 * 24)
    expect(t!.min.value).toBeLessThan(t!.mean)
    expect(t!.max.at).toMatch(/^01-\d\d \d\d:\d\d$/)
    expect(t!.monthly).toHaveLength(1)
    const [e] = await timeseries(db, { name: 'Electricity:Facility', frequency: 'Monthly' })
    expect(e!.totalKwh).toBeGreaterThan(0)
    expect(e!.values).toHaveLength(1)
    await expect(timeseries(db, { name: 'Zone Air Temperature', key: 'Nowhere' })).rejects.toThrow(/Keys: /)
  })

  it('runs read-only SELECTs only', async () => {
    const r = await querySql(db, 'SELECT ZoneName, FloorArea FROM Zones ORDER BY ZoneName')
    expect(r.columns).toEqual(['ZoneName', 'FloorArea'])
    expect(r.rows.length).toBe(6)
    await expect(querySql(db, 'DELETE FROM Zones')).rejects.toThrow(/single SELECT/)
    await expect(querySql(db, 'SELECT 1; DROP TABLE Zones')).rejects.toThrow(/single SELECT/)
  })

  it('reads what could be requested from the .rdd', () => {
    expect(parseDictionary(rdd).map((o) => o.name)).toContain('Zone Air Temperature')
  })

  // The same Python the app runs in Pyodide, under the system's Python.
  const python = ['python3', 'python'].find((p) => {
    try {
      execFileSync(p, ['--version'], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })
  it.skipIf(!python)('queries through Python’s sqlite3, as in the browser', async () => {
    const run = async (code: string) => {
      try {
        const stdout = execFileSync(python!, ['-c', `last_run = ${JSON.stringify(dir)}\n${code}`], { encoding: 'utf8' })
        return { ok: true, stdout }
      } catch (e) {
        return { ok: false, error: String((e as { stderr?: string }).stderr ?? e), stdout: '' }
      }
    }
    const r = await queryOverPython(run, 'SELECT count(*) AS n FROM Zones WHERE ZoneName LIKE ?', ['SPACE%'])
    expect(r).toEqual({ columns: ['n'], rows: [[5]] })
    await expect(queryOverPython(run, 'SELECT nope FROM Zones')).rejects.toThrow(/no such column/)
    await expect(queryOverPython(run, 'INSERT INTO Zones (ZoneName) VALUES (?)', ['x'])).rejects.toThrow(/readonly|read-only/)
    expect(existsSync(join(dir, 'eplusout.sql'))).toBe(true)
  })
})
