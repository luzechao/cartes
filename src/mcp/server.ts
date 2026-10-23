/**
 * The MCP server — Phase 9 of docs/05-implementation-plan.md: "an LLM can drive the scene. A
 * protocol, not a framework."
 *
 * A thin layer: the tools are the shared registry in `tools.ts` — each one `ModelSession` method,
 * its arguments described with zod so the client sees a schema — plus the two that need a disk.
 * Results come back as JSON text. Errors the session raises on purpose
 * (a window that does not fit, a name that does not exist) come back as tool errors carrying the
 * reason, which is what lets a model correct itself; anything else is a bug and is rethrown.
 *
 * Nothing touches the disk except `open_idf` (read) and `save_idf` (write, `.idf` only, and only
 * when asked). Every edit is undoable with `undo`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { localBundle } from '@idfkit/schemas/node'
import { ModelSession, SessionError } from './session.js'
import { sessionTools } from './tools.js'
import { setSchemaBundle } from '../schema/index.js'

setSchemaBundle(localBundle())

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function run(fn: () => unknown): ToolResult {
  try {
    const value = fn()
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
  } catch (e) {
    if (e instanceof SessionError) return { content: [{ type: 'text', text: e.message }], isError: true }
    throw e
  }
}

export function createCartesServer(session = new ModelSession()): McpServer {
  const server = new McpServer({ name: 'cartes', version: '0.9.0' })

  server.registerTool(
    'open_idf',
    { description: 'Open an EnergyPlus .idf file from disk. Replaces any open model.', inputSchema: { path: z.string() } },
    ({ path }) =>
      run(() => {
        if (extname(path).toLowerCase() !== '.idf') throw new SessionError('Only .idf files can be opened.')
        return session.openText(readFileSync(path, 'utf8'), basename(path), path)
      }),
  )

  for (const tool of sessionTools) {
    const call = async (args: Record<string, unknown>): Promise<ToolResult> => {
      await session.prepare({ prose: tool.prose === true })
      return run(() => tool.run(session, args))
    }
    if (tool.input) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, call)
    else server.registerTool(tool.name, { description: tool.description }, () => call({}))
  }

  server.registerTool(
    'save_idf',
    {
      description: 'Write the model to disk. Without a path, overwrites the file it was opened from. Must end in .idf.',
      inputSchema: { path: z.string().optional() },
    },
    ({ path }) =>
      run(() => {
        const text = session.text()
        const target = path ?? session.path
        if (!target) throw new SessionError('This model has no file yet; give a path ending in .idf.')
        if (extname(target).toLowerCase() !== '.idf') throw new SessionError('The path must end in .idf.')
        writeFileSync(target, text, 'utf8')
        return { path: target, bytes: Buffer.byteLength(text), changedObjects: session.changedObjects() }
      }),
  )

  return server
}
