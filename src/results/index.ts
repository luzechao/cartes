/**
 * Reading a simulation's results: the SQLite output (`eplusout.sql`) for tabular reports and
 * time series, and the `.rdd`/`.mdd` dictionaries for the outputs a model could request.
 *
 * Queries go through `ResultsDb`, so the same code runs against Pyodide's `sqlite3` in the app
 * (where the last run's files live) and `node:sqlite` in tests. Aggregation happens in SQL:
 * an annual hourly series is 8,760 rows, and only its summary crosses the bridge.
 */

export type Cell = string | number | null

export interface QueryResult {
  columns: string[]
  rows: Cell[][]
}

export interface ResultsDb {
  /** Run one read-only statement. Rejects with the SQLite error message. */
  query(sql: string, params?: Cell[]): Promise<QueryResult>
}

export class ResultsError extends Error {}

type Row = Record<string, Cell>

async function rows(db: ResultsDb, sql: string, params: Cell[] = []): Promise<Row[]> {
  const r = await db.query(sql, params)
  return r.rows.map((cells) => Object.fromEntries(r.columns.map((c, i) => [c, cells[i] ?? null])))
}

const str = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v).trim())

function num(v: Cell | undefined): number | undefined {
  const s = str(v)
  const n = Number(s)
  return s !== '' && Number.isFinite(n) ? n : undefined
}

function round(n: number, places = 3): number {
  const k = 10 ** places
  return Math.round(n * k) / k
}

const GJ_TO_KWH = 277.7778

// --- summary -------------------------------------------------------------------

export interface ResultsSummary {
  environments: string[]
  /** Absent when the run produced no annual summary (design days only, or no summary reports). */
  building?: { totalAreaM2?: number; conditionedAreaM2?: number }
  siteEnergy?: { gj: number; kwh: number; kwhPerM2?: number }
  sourceEnergy?: { gj: number; kwh: number; kwhPerM2?: number }
  /** Non-zero end uses by fuel, in kWh (water in m3). */
  endUses?: Array<{ endUse: string; fuel: string; value: number; units: string }>
  totalsByFuel?: Array<{ fuel: string; value: number; units: string }>
  /** Occupied hours with heating or cooling setpoints not met. */
  unmetHours?: { heating?: number; cooling?: number }
  note?: string
}

const ABUPS = 'AnnualBuildingUtilityPerformanceSummary'

export async function resultsSummary(db: ResultsDb): Promise<ResultsSummary> {
  const envs = await rows(db, 'SELECT EnvironmentName FROM EnvironmentPeriods ORDER BY EnvironmentPeriodIndex')
  const summary: ResultsSummary = { environments: envs.map((e) => str(e.EnvironmentName)) }
  const tab = await rows(
    db,
    `SELECT TableName, RowName, ColumnName, Units, Value FROM TabularDataWithStrings
     WHERE ReportName = ? AND ReportForString = 'Entire Facility'
       AND TableName IN ('Site and Source Energy', 'Building Area', 'End Uses', 'Comfort and Setpoint Not Met Summary')`,
    [ABUPS],
  )
  if (tab.length === 0) {
    summary.note =
      'No annual summary in this run: it ran design days only, or the model has no Output:Table:SummaryReports. ' +
      'run_simulation adds summary reports to its own runs; a run period needs a weather file.'
    return summary
  }
  const cell = (table: string, row: string, column: string): number | undefined =>
    num(tab.find((r) => r.TableName === table && str(r.RowName) === row && str(r.ColumnName) === column)?.Value)

  const area = cell('Building Area', 'Total Building Area', 'Area')
  const conditioned = cell('Building Area', 'Net Conditioned Building Area', 'Area')
  summary.building = {
    ...(area !== undefined ? { totalAreaM2: area } : {}),
    ...(conditioned !== undefined ? { conditionedAreaM2: conditioned } : {}),
  }
  for (const [key, row] of [
    ['siteEnergy', 'Total Site Energy'],
    ['sourceEnergy', 'Total Source Energy'],
  ] as const) {
    const gj = cell('Site and Source Energy', row, 'Total Energy')
    if (gj === undefined) continue
    const kwh = round(gj * GJ_TO_KWH, 1)
    summary[key] = { gj, kwh, ...(area ? { kwhPerM2: round(kwh / area, 2) } : {}) }
  }

  const endUses: NonNullable<ResultsSummary['endUses']> = []
  const totals: NonNullable<ResultsSummary['totalsByFuel']> = []
  for (const r of tab) {
    if (r.TableName !== 'End Uses') continue
    const value = num(r.Value)
    const endUse = str(r.RowName)
    if (!value || !endUse) continue
    const fuel = str(r.ColumnName)
    const units = str(r.Units)
    const converted = units === 'GJ' ? { value: round(value * GJ_TO_KWH, 1), units: 'kWh' } : { value, units }
    if (endUse === 'Total End Uses') totals.push({ fuel, ...converted })
    else endUses.push({ endUse, fuel, ...converted })
  }
  summary.endUses = endUses
  summary.totalsByFuel = totals
  const table = 'Comfort and Setpoint Not Met Summary'
  const heating = cell(table, 'Time Setpoint Not Met During Occupied Heating', 'Facility')
  const cooling = cell(table, 'Time Setpoint Not Met During Occupied Cooling', 'Facility')
  if (heating !== undefined || cooling !== undefined) {
    summary.unmetHours = { ...(heating !== undefined ? { heating } : {}), ...(cooling !== undefined ? { cooling } : {}) }
  }
  return summary
}

// --- tabular reports -----------------------------------------------------------------

/** Reports and their tables, optionally only those whose names contain every word of `filter`. */
export async function listReports(db: ResultsDb, filter?: string): Promise<Array<{ report: string; for: string[]; tables: string[] }>> {
  const all = await rows(
    db,
    'SELECT ReportName, ReportForString, TableName, min(TabularDataIndex) AS first FROM TabularDataWithStrings GROUP BY ReportName, ReportForString, TableName ORDER BY first',
  )
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const byReport = new Map<string, { for: Set<string>; tables: Set<string> }>()
  for (const r of all) {
    const report = str(r.ReportName)
    const table = str(r.TableName)
    const hay = `${report} ${table}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) continue
    let entry = byReport.get(report)
    if (!entry) byReport.set(report, (entry = { for: new Set(), tables: new Set() }))
    entry.for.add(str(r.ReportForString))
    entry.tables.add(table)
  }
  return [...byReport].map(([report, e]) => ({ report, for: [...e.for], tables: [...e.tables] }))
}

export interface ReportTable {
  report: string
  table: string
  for: string
  /** Other `for` values the table has (zones, systems), when it has any. */
  otherFor?: string[]
  columns: string[]
  rows: Array<{ row: string; values: string[] }>
  truncated?: boolean
}

const MAX_TABLE_ROWS = 120

/** One table of the tabular report, as rows × columns. Names match case-insensitively. */
export async function reportTable(db: ResultsDb, report: string, table: string, reportFor?: string): Promise<ReportTable> {
  const cells = await rows(
    db,
    `SELECT ReportName, ReportForString, TableName, RowName, ColumnName, Units, Value FROM TabularDataWithStrings
     WHERE lower(ReportName) = lower(?) AND lower(TableName) = lower(?) ORDER BY TabularDataIndex`,
    [report.trim(), table.trim()],
  )
  if (cells.length === 0) throw new ResultsError(`No table '${table}' in report '${report}'; see list_report_tables.`)
  const fors = [...new Set(cells.map((c) => str(c.ReportForString)))]
  const wanted = reportFor?.trim().toLowerCase()
  const chosen = wanted ? fors.find((f) => f.toLowerCase() === wanted) : (fors.find((f) => f === 'Entire Facility') ?? fors[0])
  if (!chosen) throw new ResultsError(`'${table}' is not reported for '${reportFor}'. It is for: ${fors.join(', ')}.`)

  const columns: string[] = []
  const columnIndex = new Map<string, number>()
  const rowIndex = new Map<string, number>()
  const out: ReportTable['rows'] = []
  for (const c of cells) {
    if (str(c.ReportForString) !== chosen) continue
    const units = str(c.Units)
    const column = units ? `${str(c.ColumnName)} [${units}]` : str(c.ColumnName)
    if (!columnIndex.has(column)) {
      columnIndex.set(column, columns.length)
      columns.push(column)
    }
    const rowName = str(c.RowName)
    if (!rowIndex.has(rowName)) {
      rowIndex.set(rowName, out.length)
      out.push({ row: rowName, values: [] })
    }
    out[rowIndex.get(rowName)!]!.values[columnIndex.get(column)!] = str(c.Value)
  }
  for (const r of out) for (let i = 0; i < columns.length; i++) r.values[i] ??= ''
  const kept = out.filter((r) => r.row !== '' || r.values.some((v) => v !== ''))
  const result: ReportTable = {
    report: str(cells[0]!.ReportName),
    table: str(cells[0]!.TableName),
    for: chosen,
    columns,
    rows: kept.slice(0, MAX_TABLE_ROWS),
  }
  if (fors.length > 1) result.otherFor = fors.filter((f) => f !== chosen).slice(0, 40)
  if (kept.length > MAX_TABLE_ROWS) result.truncated = true
  return result
}

// --- time series ---------------------------------------------------------------------

export interface ReportedVariable {
  name: string
  units: string
  meter: boolean
  frequencies: string[]
  keys: string[]
}

/** Variables and meters the run reported, grouped by name. */
export async function reportedVariables(db: ResultsDb, filter?: string): Promise<ReportedVariable[]> {
  const dict = await rows(db, 'SELECT IsMeter, KeyValue, Name, ReportingFrequency, Units FROM ReportDataDictionary ORDER BY ReportDataDictionaryIndex')
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const byName = new Map<string, ReportedVariable>()
  for (const d of dict) {
    const name = str(d.Name)
    const hay = `${name} ${str(d.KeyValue)}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) continue
    let v = byName.get(name)
    if (!v) byName.set(name, (v = { name, units: str(d.Units), meter: Number(d.IsMeter) === 1, frequencies: [], keys: [] }))
    const f = str(d.ReportingFrequency)
    if (!v.frequencies.includes(f)) v.frequencies.push(f)
    const k = str(d.KeyValue)
    if (k && !v.keys.includes(k)) v.keys.push(k)
  }
  return [...byName.values()]
}

export interface SeriesStats {
  name: string
  key: string
  units: string
  frequency: string
  /** `Sum` for energies and meters, `Avg` for states such as temperature. */
  aggregation: string
  count: number
  min: { value: number; at: string }
  max: { value: number; at: string }
  mean: number
  /** For `Sum` series; also in kWh when the units are J. */
  total?: number
  totalKwh?: number
  /** Per month: the sum for `Sum` series, the mean otherwise. */
  monthly?: Array<{ month: number; value: number }>
  /** Every value, when there are few. */
  values?: Array<{ at: string; value: number }>
}

const MAX_POINTS = 48

const FREQ_RANK = ['Timestep', 'Zone Timestep', 'HVAC System Timestep', 'Hourly', 'Daily', 'Monthly', 'Run Period', 'Annual']

function stamp(r: Row): string {
  const p = (n: Cell | undefined): string => String(n ?? 0).padStart(2, '0')
  return `${p(r.Month)}-${p(r.Day)} ${p(r.Hour)}:${p(r.Minute)}`
}

/**
 * Summaries of a reported variable or meter: one per key, or the key asked for, at the finest
 * frequency reported unless one is asked for. Warm-up days are excluded; when the run had run
 * periods, only they count (design days are sizing, not results).
 */
export async function timeseries(
  db: ResultsDb,
  args: { name: string; key?: string | undefined; frequency?: string | undefined },
): Promise<SeriesStats[]> {
  const dict = await rows(
    db,
    'SELECT ReportDataDictionaryIndex AS id, KeyValue, Name, ReportingFrequency, Units, Type FROM ReportDataDictionary WHERE lower(Name) = lower(?)',
    [args.name.trim()],
  )
  if (dict.length === 0) {
    throw new ResultsError(`'${args.name}' was not reported in this run; see list_output_variables, and request it with add_outputs.`)
  }
  let matches = dict
  if (args.key) {
    const key = args.key.trim().toLowerCase()
    matches = matches.filter((d) => str(d.KeyValue).toLowerCase() === key)
    if (matches.length === 0) throw new ResultsError(`No '${args.name}' for '${args.key}'. Keys: ${[...new Set(dict.map((d) => str(d.KeyValue)))].join(', ')}.`)
  }
  if (args.frequency) {
    const f = args.frequency.trim().toLowerCase()
    const all = matches
    matches = matches.filter((d) => str(d.ReportingFrequency).toLowerCase() === f)
    if (matches.length === 0) throw new ResultsError(`'${args.name}' is reported at: ${[...new Set(all.map((d) => str(d.ReportingFrequency)))].join(', ')}.`)
  } else {
    const rank = (d: Row): number => {
      const i = FREQ_RANK.indexOf(str(d.ReportingFrequency))
      return i < 0 ? FREQ_RANK.length : i
    }
    const best = new Map<string, Row>()
    for (const d of matches) {
      const k = str(d.KeyValue)
      if (!best.has(k) || rank(d) < rank(best.get(k)!)) best.set(k, d)
    }
    matches = [...best.values()]
  }
  if (matches.length > 30) throw new ResultsError(`${matches.length} keys report '${args.name}'; give a key.`)

  const runPeriods = await rows(db, 'SELECT EnvironmentPeriodIndex FROM EnvironmentPeriods WHERE EnvironmentType = 3')
  const envFilter = runPeriods.length ? `AND t.EnvironmentPeriodIndex IN (${runPeriods.map((r) => Number(r.EnvironmentPeriodIndex)).join(',')})` : ''
  const from = `FROM ReportData d JOIN Time t ON d.TimeIndex = t.TimeIndex
    WHERE d.ReportDataDictionaryIndex = ? AND (t.WarmupFlag IS NULL OR t.WarmupFlag = 0) ${envFilter}`

  const out: SeriesStats[] = []
  for (const d of matches) {
    const id = Number(d.id)
    const [agg] = await rows(db, `SELECT count(*) AS n, avg(d.Value) AS mean, sum(d.Value) AS total ${from}`, [id])
    const n = Number(agg?.n ?? 0)
    if (n === 0) continue
    const [lo] = await rows(db, `SELECT d.Value, t.Month, t.Day, t.Hour, t.Minute ${from} ORDER BY d.Value ASC LIMIT 1`, [id])
    const [hi] = await rows(db, `SELECT d.Value, t.Month, t.Day, t.Hour, t.Minute ${from} ORDER BY d.Value DESC LIMIT 1`, [id])
    const isSum = str(d.Type) === 'Sum'
    const units = str(d.Units)
    const s: SeriesStats = {
      name: str(d.Name),
      key: str(d.KeyValue),
      units,
      frequency: str(d.ReportingFrequency),
      aggregation: str(d.Type),
      count: n,
      min: { value: round(Number(lo!.Value), 4), at: stamp(lo!) },
      max: { value: round(Number(hi!.Value), 4), at: stamp(hi!) },
      mean: round(Number(agg!.mean), 4),
    }
    if (isSum) {
      s.total = round(Number(agg!.total), 4)
      if (units === 'J') s.totalKwh = round(Number(agg!.total) / 3.6e6, 2)
    }
    const monthly = await rows(db, `SELECT t.Month AS month, ${isSum ? 'sum' : 'avg'}(d.Value) AS value ${from} GROUP BY t.Month ORDER BY t.Month`, [id])
    if (n > 1 && monthly.length > 0) s.monthly = monthly.map((m) => ({ month: Number(m.month), value: round(Number(m.value), 4) }))
    if (n <= MAX_POINTS) {
      const pts = await rows(db, `SELECT d.Value, t.Month, t.Day, t.Hour, t.Minute ${from} ORDER BY d.TimeIndex`, [id])
      s.values = pts.map((p) => ({ at: stamp(p), value: round(Number(p.Value), 4) }))
    }
    out.push(s)
  }
  return out
}

// --- free-form SQL -----------------------------------------------------------------------

const MAX_SQL_ROWS = 200

/** One SELECT (or WITH … SELECT), capped at 200 rows. The database is opened read-only besides. */
export async function querySql(db: ResultsDb, sql: string): Promise<QueryResult & { truncated?: boolean }> {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(text) || text.includes(';')) throw new ResultsError('Only a single SELECT statement is allowed.')
  const r = await db.query(`SELECT * FROM (${text}) LIMIT ${MAX_SQL_ROWS + 1}`)
  return r.rows.length > MAX_SQL_ROWS ? { columns: r.columns, rows: r.rows.slice(0, MAX_SQL_ROWS), truncated: true } : r
}

// --- output dictionaries (.rdd, .mdd) ------------------------------------------------------

export interface AvailableOutput {
  name: string
  units: string
  /** `Zone` or `HVAC` time step. */
  kind: string
  /** `Average`, `Sum` or `Meter`. */
  type: string
}

/**
 * Parse `eplusout.rdd` or `eplusout.mdd` in either layout: `Regular`
 * (`Zone,Average,Zone Air Temperature [C]`) or `IDF`
 * (`Output:Variable,*,Zone Air Temperature,hourly; !- Zone Average [C]`).
 */
export function parseDictionary(text: string): AvailableOutput[] {
  const out: AvailableOutput[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('Program Version') || line.startsWith('Var Type') || line.startsWith('!')) continue
    const idf = /^Output:(?:Variable|Meter)[^,]*,(?:\*,)?([^,;]+)[,;].*?!-\s*(\w+)\s+(\w+)\s*\[([^\]]*)\]/i.exec(line)
    if (idf) {
      out.push({ name: idf[1]!.trim(), units: idf[4]!.trim(), kind: idf[2]!, type: idf[3]! })
      continue
    }
    const regular = /^([^,]+),([^,]+),(.+?)\s*\[([^\]]*)\]\s*$/.exec(line)
    if (regular) out.push({ name: regular[3]!.trim(), units: regular[4]!.trim(), kind: regular[1]!.trim(), type: regular[2]!.trim() })
  }
  return out
}

/** Entries of a dictionary whose names contain every word of `filter`. */
export function filterOutputs(list: readonly AvailableOutput[], filter?: string, limit = 80): { matches: AvailableOutput[]; total: number } {
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = list.filter((o) => words.every((w) => o.name.toLowerCase().includes(w)))
  return { matches: hits.slice(0, limit), total: hits.length }
}

/**
 * Output requests for a run that the agent will read results from, added to the simulated text
 * only — the model is not changed: SQLite output, the variable dictionary and the summary
 * reports. Each is added only when the model has none of its class.
 */
export function withResultOutputs(idf: string): { idf: string; added: string[] } {
  const has = (cls: string): boolean => new RegExp(`^\\s*${cls.replace(/:/g, ':')}\\s*,`, 'im').test(idf)
  const add: string[] = []
  if (!has('Output:SQLite')) add.push('Output:SQLite,SimpleAndTabular;')
  if (!has('Output:VariableDictionary')) add.push('Output:VariableDictionary,IDF;')
  if (!has('Output:Table:SummaryReports')) add.push('Output:Table:SummaryReports,AllSummary;')
  if (add.length === 0) return { idf, added: [] }
  return { idf: `${idf.replace(/\s*$/, '\n')}\n${add.join('\n\n')}\n`, added: add.map((a) => a.split(',')[0]!) }
}
