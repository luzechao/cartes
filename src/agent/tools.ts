/**
 * The agent's tools: the shared model tools of `src/mcp/tools.ts`, run against the document open
 * in the app; Python and simulation in the app's own engine; the last run's results; and weather.
 *
 * Edits go through cartes, never through Python: the model tools keep twins in step and write
 * field-level, undoable changes, and each tool call becomes one undo step labelled "Agent: …".
 * In "ask" mode an edit waits for the user to approve it; a rejection is returned to the model as
 * a result, not an error, so it can carry on with the user's wishes.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { ModelSession, SessionError, type AttachedDocument } from '../mcp/session.js'
import { parameter, sessionTools, type SessionTool, type ToolKind } from '../mcp/tools.js'
import { emitIdf } from '../parser/index.js'
import { comparisonCharts, type ScenarioBatchResult, type ScenarioInput } from '../simulate/index.js'
import { exampleInput, exampleLibrary, fetchRemoteExample } from '../mcp/examples.js'
import { datasetImportInput, datasetInput, datasetLibrary, planDatasetImport } from '../mcp/datasets.js'
import { manualInput, readManualSection } from '../mcp/manual.js'
import {
  filterOutputs,
  listReports,
  parseDictionary,
  querySql,
  reportedVariables,
  reportTable,
  resultsSummary,
  seriesChart,
  timeseries,
  withResultOutputs,
  type Cell,
  type QueryResult,
  type ResultsDb,
  type SeriesStats,
} from '../results/index.js'
import { searchStations, type StationSummary } from '../weather/index.js'
import type { EditMode } from './settings.js'

export interface ApprovalRequest {
  toolCallId: string
  toolName: string
  kind: ToolKind
  input: unknown
}

export interface PythonOutcome {
  ok: boolean
  value?: string | undefined
  error?: string | undefined
  stdout: string
  stderr: string
}

export interface SimulationReport {
  [key: string]: unknown
}

/** What the agent needs from the app. */
export interface AgentHost {
  /** The open document, or undefined if none is. */
  document(): AttachedDocument | undefined
  /** After an edit: rebuild the 3D view, validation and changes from the document. */
  afterEdit(): void
  editMode(): EditMode
  /** Resolves true to go ahead. Must resolve false if `signal` aborts. */
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>
  runPython(code: string): Promise<PythonOutcome>
  runSimulation(): Promise<SimulationReport>
  runScenarios(scenarios: readonly ScenarioInput[], modelName: string, signal?: AbortSignal): Promise<{
    result?: ScenarioBatchResult | undefined; error?: string | undefined; weather: string
  }>
  readTimeseries(args: { name: string; key?: string | undefined; frequency?: string | undefined }): Promise<SeriesStats[]>
  /** One statement against the last run's `eplusout.sql`. Rejects when there is none. */
  queryResults(sql: string, params: Cell[]): Promise<QueryResult>
  /** A text output file of the last run (`eplusout.rdd`, …), if there was one. */
  outputText(name: string): string | undefined
  /** Download a weather station's files and make its EPW the Simulate tab's weather. */
  useWeather(id: string): Promise<{ station: StationSummary; designDays: string[] }>
  /** The DDY of the weather last loaded by `useWeather`. */
  lastDesignConditions(): string | undefined
}

/** Characters of tool output passed back to the model; the rest is cut. */
export const MAX_OUTPUT = 30_000

export function limitOutput(value: unknown, max = MAX_OUTPUT): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined || text.length <= max) return value
  return {
    truncated: true,
    note: `Output cut to ${max} of ${text.length} characters; ask for less (e.g. one zone, one class).`,
    text: text.slice(0, max),
  }
}

// Undo and redo move the history itself, so they cannot run inside a transaction.
const UNTRANSACTED = new Set(['undo', 'redo'])

const NO_MODEL = { error: 'No model is open in cartes. Ask the user to open an IDF or load an example.' }

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createAgentTools(host: AgentHost, session = new ModelSession()): ToolSet {
  const tools: ToolSet = {}

  /** A model tool: approval for edits, then one undo step against the app's document. */
  const modelTool = (t: SessionTool) =>
    tool({
      description: t.description,
      inputSchema: z.object(t.input ?? {}),
      execute: async (args: Record<string, unknown>, { toolCallId, abortSignal }) => {
        if (!host.document()) return NO_MODEL
        if (t.kind !== 'read' && host.editMode() === 'ask') {
          const approved = await host.approve({ toolCallId, toolName: t.name, kind: t.kind, input: args }, abortSignal)
          if (!approved) {
            return { rejected: true, message: 'The user declined this edit. Do not retry it; ask what they would like instead.' }
          }
        }
        // Attach now, not before approval: the user may have edited while deciding.
        if (!host.document()) return NO_MODEL
        session.attach(host.document()!)
        await session.prepare({ prose: t.prose === true })
        // Again, since loading the schema may have yielded to the app.
        const doc = host.document()
        if (!doc) return NO_MODEL
        session.attach(doc)
        try {
          const value =
            t.kind === 'read' || UNTRANSACTED.has(t.name)
              ? t.run(session, args)
              : session.transact(`Agent: ${t.name.replace(/_/g, ' ')}`, () => t.run(session, args))
          return limitOutput(value ?? { ok: true })
        } catch (e) {
          if (e instanceof SessionError) return { error: e.message }
          throw e
        } finally {
          if (t.kind !== 'read') host.afterEdit()
        }
      },
    })

  for (const t of sessionTools) if (!t.mcpOnly) tools[t.name] = modelTool(t)

  tools.run_python = tool({
    description:
      'Run Python in the app’s Pyodide interpreter, for calculation and for reading simulation results — never to ' +
      'edit the model (use the model tools). The namespace persists between calls and is shared with the user’s ' +
      'Python REPL: `last_run` is the output directory of the last simulation (eplusout.sql, eplusout.csv, ' +
      'eplustbl.htm, …), `api` is pyenergyplus’s EnergyPlusAPI. The value of a final expression is returned; print ' +
      'for more; top-level await works. Packages: `import pyodide_js; await pyodide_js.loadPackage("numpy")`.',
    inputSchema: z.object({ code: z.string() }),
    execute: async ({ code }) => limitOutput(await host.runPython(code)),
  })

  tools.run_simulation = tool({
    description:
      'Simulate the open model, with its unsaved edits, in EnergyPlus in the browser — using the weather file and ' +
      'Python plugin files loaded in the Simulate tab. Without weather, only design days run. For this run only, ' +
      'SQLite output, the variable dictionary and the summary reports are requested if the model lacks them, so the ' +
      'results tools can read it. Returns the outcome, severe and fatal messages and the output files.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!host.document()) return NO_MODEL
      return limitOutput(await host.runSimulation())
    },
  })

  tools.run_scenarios = tool({
    description:
      'Run 2–6 named scenarios sequentially using isolated copies of the current model and the same weather. ' +
      'Changes are hypothetical and do not edit the open model. Supports selected semantic parameters and constant schedules; ' +
      'include a baseline with no changes. Stops on a failed run or a browser storage error, and saves each returned run locally before the next. ' +
      'The last scenario becomes last_run. Python plugins are not supported. Stopping waits for the current run to finish.',
    inputSchema: z.object({
      scenarios: z.array(z.object({
        name: z.string().trim().min(1).max(80),
        changes: z.array(z.discriminatedUnion('type', [
          z.object({ type: z.literal('parameter'), parameter, name: z.string(), class: z.string().optional(), value: z.number() }),
          z.object({ type: z.literal('constant_schedule'), name: z.string(), value: z.number(), acknowledge_shared: z.boolean().optional() }),
        ])).max(20),
      })).min(2).max(6),
    }),
    execute: async ({ scenarios }, { abortSignal }) => {
      const doc = host.document()
      if (!doc) return NO_MODEL
      const names = new Set(scenarios.map((scenario) => scenario.name.trim().toLowerCase()))
      if (names.size !== scenarios.length) return { error: 'Scenario names must be distinct.' }
      if (doc.doc.byClass.has('pythonplugin:instance')) return { error: 'Scenario batches do not support PythonPlugin:Instance objects; plugin state can persist in the shared interpreter.' }
      const source = emitIdf(doc.doc)
      const prepared: ScenarioInput[] = []
      const changes: Array<{ name: string; changes: unknown[]; outputsAddedForThisRun: string[] }> = []
      for (const scenario of scenarios) {
        if (abortSignal?.aborted) return { cancelled: true, message: 'Scenario batch cancelled before running.' }
        try {
          const copy = new ModelSession()
          copy.openText(source, doc.name)
          await copy.prepare()
          const applied = scenario.changes.map((change) => change.type === 'parameter'
            ? copy.setParameter(change.parameter, change.name, change.value, change.class)
            : copy.setConstantSchedule(change.name, change.value, change.acknowledge_shared))
          const outputs = withResultOutputs(copy.text())
          prepared.push({ name: scenario.name, idf: outputs.idf })
          changes.push({ name: scenario.name, changes: applied, outputsAddedForThisRun: outputs.added })
        } catch (error) {
          return { error: `Scenario '${scenario.name}': ${message(error)}`, message: 'No simulations were started.' }
        }
      }
      try {
        const batch = await host.runScenarios(prepared, doc.name, abortSignal)
        if (!batch.result) return { error: batch.error ?? 'Scenario batch failed.', weather: batch.weather }
        return limitOutput({
          weather: batch.weather, stopped: batch.result.stopped, cancelled: batch.result.cancelled,
          retentionError: batch.result.retentionError,
          scenarios: batch.result.scenarios.map((result) => ({ ...result, ...changes.find((entry) => entry.name === result.name) })),
          charts: comparisonCharts(batch.result.scenarios),
          note: 'Each summary was captured before the next run. Saved scenario outputs can be exported from Simulate > Files; browser storage may be cleared or evicted. Results tools and Python last_run still access only the last worker run. Missing annual summaries are not zero; the open model was not edited.',
        })
      } catch (error) {
        return { error: message(error) }
      }
    },
  })

  // --- results of the last run ---------------------------------------------------------

  const db: ResultsDb = { query: (sql, params) => host.queryResults(sql, params ?? []) }
  const read = <A,>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return limitOutput(await fn(args))
    } catch (e) {
      return { error: message(e) }
    }
  }

  tools.example_library = tool({
    description: 'Search the catalog of EnergyPlus examples for the bundled engine version. Inspecting a non-bundled example fetches that one public file from the pinned GitHub commit.',
    inputSchema: z.object(exampleInput),
    execute: read((args) => exampleLibrary(args, async (filename, bundled) => {
      if (!bundled) return fetchRemoteExample(filename)
      const response = await fetch(`${import.meta.env?.BASE_URL ?? '/'}examples/${filename}`)
      if (!response.ok) throw new Error(`Could not load example ${filename}: HTTP ${response.status}`)
      return response.text()
    })),
  })

  tools.dataset_library = tool({
    description: 'Search filenames in the bundled engine version’s EnergyPlus DataSets, inspect classes/objects, or build a bounded read-only import plan. Use import_dataset to import a complete, compatible dependency closure.',
    inputSchema: z.object(datasetInput),
    execute: read((args) => datasetLibrary(args)),
  })

  tools.import_dataset = tool({
    description: 'Import one named object and its IDD-referenced dependencies from the pinned EnergyPlus DataSet into the open model. Builds a read-only plan first; in ask mode, requests approval before attaching the latest document and rerunning version, reference, field, and name-conflict checks. The complete import is one undoable edit.',
    inputSchema: z.object(datasetImportInput),
    execute: async (args, { toolCallId, abortSignal }) => {
      if (!host.document()) return NO_MODEL
      try {
        const plan = await planDatasetImport(args)
        if (plan.truncated) return { error: 'Cannot import a truncated DataSet plan. Increase the plan limit or choose a smaller dependency closure.' }
        if (plan.references.some((reference) => reference.status === 'ambiguous')) {
          return { error: 'Cannot import a DataSet plan with ambiguous IDD references.' }
        }
        if (abortSignal?.aborted) return { error: 'DataSet import was cancelled before approval.' }
        if (host.editMode() === 'ask') {
          const approved = await host.approve({
            toolCallId,
            toolName: 'import_dataset',
            kind: 'edit',
            input: {
              file: plan.file,
              version: plan.version,
              root: plan.root,
              objects: plan.objects.map(({ class: className, name }) => ({ class: className, name })),
              referencesRequiringTarget: plan.references
                .filter((reference) => reference.status === 'not_in_dataset')
                .map(({ from, field, name }) => ({ from, field, name })),
            },
          }, abortSignal)
          if (!approved) return { rejected: true, message: 'The user declined this edit. Do not retry it; ask what they would like instead.' }
        }
        const latest = host.document()
        if (!latest) return NO_MODEL
        session.attach(latest)
        await session.prepare()
        const current = host.document()
        if (!current) return NO_MODEL
        session.attach(current)
        const result = session.importDatasetObjects(plan.version, plan.objects.map((object) => ({
          class: object.class,
          name: object.name,
          fields: object.fields.map(({ index, value }) => ({ index, value })),
        })), 'Agent: import dataset')
        host.afterEdit()
        return limitOutput({ source: { file: plan.file, version: plan.version, root: plan.root }, ...result })
      } catch (e) {
        if (e instanceof SessionError) return { error: e.message }
        return { error: message(e) }
      }
    },
  })

  tools.read_manual_section = tool({
    description: 'Fetch a version-matched object section from the online EnergyPlus I/O Reference at docs.idfkit.com, paged as plain text. Sends the public object-class documentation URL to that site.',
    inputSchema: z.object(manualInput),
    execute: read(async (args) => {
      const doc = host.document()
      const current = doc ? session : new ModelSession()
      if (doc) current.attach(doc)
      await current.prepare()
      const url = current.describeClass(args.class).docs
      if (!url) throw new SessionError(`No manual URL is available for ${args.class}.`)
      return readManualSection(url, args)
    }),
  })

  tools.results_summary = tool({
    description:
      'The last run at a glance: environments, floor area, site and source energy (kWh, kWh/m2), non-zero end uses ' +
      'by fuel, and unmet heating and cooling hours.',
    inputSchema: z.object({}),
    execute: read(() => resultsSummary(db)),
  })

  tools.list_report_tables = tool({
    description:
      'The tabular reports of the last run (EnvelopeSummary, EquipmentSummary, HVACSizingSummary, …) and their ' +
      'tables, filtered by words in their names.',
    inputSchema: z.object({ filter: z.string().optional() }),
    execute: read(({ filter }: { filter?: string | undefined }) => listReports(db, filter)),
  })

  tools.get_report_table = tool({
    description:
      'One table of the last run’s tabular reports, as rows × columns with units. `for` picks a zone or system when ' +
      'the table is reported per object; the default is the whole facility.',
    inputSchema: z.object({ report: z.string(), table: z.string(), for: z.string().optional() }),
    execute: read((a: { report: string; table: string; for?: string | undefined }) => reportTable(db, a.report, a.table, a.for)),
  })

  tools.list_output_variables = tool({
    description:
      'Output variables and meters: those the last run reported (with keys and frequencies, readable with ' +
      'get_timeseries), and those the model could request (from the run’s .rdd and .mdd), filtered by words.',
    inputSchema: z.object({ filter: z.string().optional() }),
    execute: read(async ({ filter }: { filter?: string | undefined }) => {
      const available = [...parseDictionary(host.outputText('eplusout.rdd') ?? ''), ...parseDictionary(host.outputText('eplusout.mdd') ?? '')]
      let reported: unknown
      try {
        reported = await reportedVariables(db, filter)
      } catch (e) {
        reported = { error: message(e) }
      }
      return {
        reported,
        available: available.length ? filterOutputs(available, filter) : 'No .rdd/.mdd from the last run; run_simulation writes them.',
      }
    }),
  })

  tools.get_timeseries = tool({
    description:
      'Statistics of a reported variable or meter in the last run: count, min and max with their times, mean, ' +
      'total (kWh too, for J), and monthly values; every value when there are few. One entry per key unless a key ' +
      'is given. For anything finer, use run_python with sqlite3 on last_run + "/eplusout.sql".',
    inputSchema: z.object({ name: z.string(), key: z.string().optional(), frequency: z.string().optional() }),
    execute: read((a: { name: string; key?: string | undefined; frequency?: string | undefined }) => timeseries(db, a)),
  })

  tools.plot_timeseries = tool({
    description: 'Plot one reported variable or meter from the last run. Supply a key when several are reported. Shows every value for up to 48 points, otherwise monthly sums or means. Missing outputs require add_outputs and another simulation.',
    inputSchema: z.object({ name: z.string(), key: z.string().optional(), frequency: z.string().optional() }),
    execute: read(async (args) => {
      const series = await host.readTimeseries(args)
      if (series.length !== 1) throw new Error(series.length ? `This variable has ${series.length} keys; supply a key.` : 'No values were recorded for this variable.')
      const { chart, note } = seriesChart(series[0]!)
      return { charts: [chart], note, statistics: series[0] }
    }),
  })

  tools.query_results = tool({
    description:
      'One read-only SELECT against the last run’s eplusout.sql (tables include TabularDataWithStrings, ' +
      'ReportDataDictionary, ReportData, Time, Zones, Surfaces, Constructions, ComponentSizes), up to 200 rows.',
    inputSchema: z.object({ sql: z.string() }),
    execute: read(({ sql }: { sql: string }) => querySql(db, sql)),
  })

  // --- weather -------------------------------------------------------------------------------

  tools.search_weather = tool({
    description:
      'Search climate.onebuilding.org TMYx weather stations by place, WMO number or file name — or, with no query, ' +
      'those nearest the given coordinates or the model’s Site:Location. Returns ids for use_weather, with climate ' +
      'zone, degree-days and design temperatures.',
    inputSchema: z.object({
      query: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      country: z.string().optional().describe('ISO code, e.g. USA, CHN, GBR'),
      limit: z.number().int().positive().optional(),
    }),
    execute: read(async (a: { query?: string | undefined; latitude?: number | undefined; longitude?: number | undefined; country?: string | undefined; limit?: number | undefined }) => {
      let { latitude, longitude } = a
      if (!a.query && (latitude === undefined || longitude === undefined)) {
        const doc = host.document()
        if (!doc) return NO_MODEL
        session.attach(doc)
        await session.prepare()
        const loc = session.simulationSettings().location
        latitude = Number(loc?.latitude)
        longitude = Number(loc?.longitude)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { error: 'The model has no Site:Location; give a place or coordinates.' }
      }
      return searchStations({ ...a, latitude, longitude })
    }),
  })

  tools.use_weather = tool({
    description:
      'Download a weather station’s files (by id from search_weather) and make its EPW the weather for simulations. ' +
      'Does not change the model; returns the DDY’s design days, which apply_design_conditions can put in the model.',
    inputSchema: z.object({ id: z.string() }),
    execute: read(({ id }: { id: string }) => host.useWeather(id)),
  })

  tools.apply_design_conditions = modelTool({
    name: 'apply_design_conditions',
    kind: 'edit',
    description:
      'From the weather loaded by use_weather: replace the model’s SizingPeriod:DesignDay objects with the DDY’s ' +
      '(by default annual 99.6% heating and 0.4% cooling dry-bulb), and set Site:Location to the station’s. One undo step.',
    input: {
      design_days: z.array(z.string()).optional().describe('Parts of DDY design-day names, e.g. "Ann Clg 1% Condns DB=>MWB".'),
      location: z.boolean().optional().describe('Also set Site:Location; default true.'),
    },
    run: (s, a) => {
      const ddy = host.lastDesignConditions()
      if (!ddy) throw new SessionError('No design conditions loaded; call use_weather first.')
      return s.applyDesignConditions(ddy, { designDays: a.design_days as string[] | undefined, location: a.location as boolean | undefined })
    },
  })

  return tools
}

/** Which tools would ask before running in "ask" mode. */
export function needsApproval(toolName: string): boolean {
  if (toolName === 'apply_design_conditions') return true
  const t = sessionTools.find((x) => x.name === toolName)
  return t !== undefined && t.kind !== 'read'
}
