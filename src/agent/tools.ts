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
import { sessionTools, type SessionTool, type ToolKind } from '../mcp/tools.js'
import {
  filterOutputs,
  listReports,
  parseDictionary,
  querySql,
  reportedVariables,
  reportTable,
  resultsSummary,
  timeseries,
  type Cell,
  type QueryResult,
  type ResultsDb,
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

  // --- results of the last run ---------------------------------------------------------

  const db: ResultsDb = { query: (sql, params) => host.queryResults(sql, params ?? []) }
  const read = <A,>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return limitOutput(await fn(args))
    } catch (e) {
      return { error: message(e) }
    }
  }

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
