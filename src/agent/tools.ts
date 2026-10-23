/**
 * The agent's tools: the shared model tools of `src/mcp/tools.ts`, run against the document open
 * in the app, plus Python and simulation in the app's own engine.
 *
 * Edits go through cartes, never through Python: the model tools keep twins in step and write
 * field-level, undoable changes, and each tool call becomes one undo step labelled "Agent: …".
 * In "ask" mode an edit waits for the user to approve it; a rejection is returned to the model as
 * a result, not an error, so it can carry on with the user's wishes.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { ModelSession, SessionError, type AttachedDocument } from '../mcp/session.js'
import { sessionTools, type ToolKind } from '../mcp/tools.js'
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

export function createAgentTools(host: AgentHost, session = new ModelSession()): ToolSet {
  const tools: ToolSet = {}

  for (const t of sessionTools) {
    if (t.mcpOnly) continue
    tools[t.name] = tool({
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
  }

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
      'Python plugin files loaded in the Simulate tab. Without weather, only design days run. Returns the outcome, ' +
      'severe and fatal messages and the output files; read them afterwards with run_python via `last_run`.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!host.document()) return NO_MODEL
      return limitOutput(await host.runSimulation())
    },
  })

  return tools
}

/** Which tools would ask before running in "ask" mode. */
export function needsApproval(toolName: string): boolean {
  const t = sessionTools.find((x) => x.name === toolName)
  return t !== undefined && t.kind !== 'read'
}
