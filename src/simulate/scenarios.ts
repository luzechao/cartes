import { resultsSummary, type ResultsDb, type ResultsSummary } from '../results/index.js'
import type { SimulationOutcome, SimulationRequest } from './protocol.js'

export interface ScenarioInput {
  name: string
  idf: string
}

export interface ScenarioResult {
  name: string
  status: 'completed' | 'failed' | 'error'
  exitCode?: number | undefined
  completion?: string | undefined
  warnings?: number | undefined
  severeAndFatal?: Array<{ severity: string; message: string; details: string[] }> | undefined
  results?: Pick<ResultsSummary, 'environments' | 'building' | 'siteEnergy' | 'sourceEnergy' | 'unmetHours' | 'note'> | undefined
  error?: string | undefined
  retained?: boolean | undefined
}

export interface ScenarioBatchResult {
  scenarios: ScenarioResult[]
  /** Full outputs of the last attempted run only, when it returned an outcome. */
  lastOutcome?: SimulationOutcome | undefined
  stopped: boolean
  cancelled?: boolean | undefined
  retentionError?: string | undefined
}

export type RetainScenario = (scenario: ScenarioInput, result: ScenarioResult, outcome: SimulationOutcome) => Promise<void>

/** Callers must reserve the worker queue for the entire batch, including the SQL queries. */
export async function runScenarioBatch(
  scenarios: readonly ScenarioInput[],
  common: Omit<SimulationRequest, 'idf'>,
  run: (request: SimulationRequest) => Promise<SimulationOutcome>,
  db: ResultsDb,
  cancelled: () => boolean = () => false,
  retain?: RetainScenario,
): Promise<ScenarioBatchResult> {
  const results: ScenarioResult[] = []
  let lastOutcome: SimulationOutcome | undefined
  for (const scenario of scenarios) {
    if (cancelled()) return { scenarios: results, lastOutcome, stopped: true, cancelled: true }
    let outcome: SimulationOutcome
    try {
      outcome = await run({ ...common, idf: scenario.idf })
    } catch (error) {
      results.push({ name: scenario.name, status: 'error', error: error instanceof Error ? error.message : String(error) })
      return { scenarios: results, stopped: true }
    }
    lastOutcome = outcome
    const report: ScenarioResult = {
      name: scenario.name,
      status: outcome.exitCode === 0 && outcome.summary?.success ? 'completed' : 'failed',
      exitCode: outcome.exitCode,
      completion: outcome.summary?.raw,
      warnings: outcome.messages.filter((message) => message.severity === 'warning').length,
      severeAndFatal: outcome.messages.filter((message) => message.severity !== 'warning')
        .slice(0, 20).map((message) => ({ severity: message.severity, message: message.message, details: message.details.slice(0, 6) })),
    }
    results.push(report)
    if (report.status === 'completed') {
      try {
        if (!outcome.outputs['eplusout.sql']) throw new Error('The run produced no eplusout.sql.')
        const { environments, building, siteEnergy, sourceEnergy, unmetHours, note } = await resultsSummary(db)
        report.results = {
          environments, ...(building && { building }), ...(siteEnergy && { siteEnergy }), ...(sourceEnergy && { sourceEnergy }),
          ...(unmetHours && { unmetHours }), ...(note && { note }),
        }
      } catch (error) {
        report.error = `Could not read this run's results: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (retain) {
      try {
        await retain(scenario, report, outcome)
        report.retained = true
      } catch (error) {
        report.retained = false
        return {
          scenarios: results, lastOutcome, stopped: true,
          retentionError: `Could not retain '${scenario.name}' in browser storage: ${error instanceof Error ? error.message : String(error)}. The batch stopped; its files remain available as the current run until replaced.`,
        }
      }
    }
    if (report.status !== 'completed') return { scenarios: results, lastOutcome, stopped: true }
  }
  return { scenarios: results, lastOutcome, stopped: false }
}

export interface ComparisonChart {
  kind: 'bar'
  title: string
  units: string
  points: Array<{ label: string; value: number }>
}

export function comparisonCharts(scenarios: readonly ScenarioResult[]): ComparisonChart[] {
  const metrics = [
    { title: 'Site energy', units: 'kWh', value: (result: ScenarioResult) => result.results?.siteEnergy?.kwh },
    { title: 'Site energy intensity', units: 'kWh/m²', value: (result: ScenarioResult) => result.results?.siteEnergy?.kwhPerM2 },
    { title: 'Occupied unmet heating hours', units: 'h', value: (result: ScenarioResult) => result.results?.unmetHours?.heating },
    { title: 'Occupied unmet cooling hours', units: 'h', value: (result: ScenarioResult) => result.results?.unmetHours?.cooling },
  ]
  return metrics.flatMap((metric) => {
    const points = scenarios.flatMap((result) => {
      const value = metric.value(result)
      return result.status === 'completed' && value !== undefined && Number.isFinite(value) && value >= 0
        ? [{ label: result.name, value }]
        : []
    })
    return points.length >= 2 ? [{ kind: 'bar', title: metric.title, units: metric.units, points }] : []
  })
}
