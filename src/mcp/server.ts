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
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { localBundle } from '@idfkit/schemas/node'
import { ModelSession, SessionError } from './session.js'
import { sessionTools } from './tools.js'
import { setSchemaBundle } from '../schema/index.js'
import { exampleInput, exampleLibrary, fetchRemoteExample } from './examples.js'
import { datasetImportInput, datasetInput, datasetLibrary, planDatasetImport } from './datasets.js'
import { manualInput, readManualSection } from './manual.js'

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
    'example_library',
    {
      description: 'Search the catalog of EnergyPlus examples for the bundled engine version. Inspecting a non-bundled example fetches that one public file from the pinned GitHub commit.',
      inputSchema: exampleInput,
    },
    async (args) => {
      try {
        const result = await exampleLibrary(args, (name, bundled) =>
          bundled ? readFile(new URL(`../../public/examples/${name}`, import.meta.url), 'utf8') : fetchRemoteExample(name),
        )
        return run(() => result)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    },
  )

  server.registerTool(
    'dataset_library',
    {
      description: 'Search filenames in the bundled engine version’s EnergyPlus DataSets, inspect classes/objects, or build a bounded read-only import plan. Use import_dataset to import a complete, compatible dependency closure.',
      inputSchema: datasetInput,
    },
    async (args) => {
      try {
        const result = await datasetLibrary(args)
        return run(() => result)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    },
  )

  server.registerTool(
    'import_dataset',
    {
      description: 'Import one named object and its IDD-referenced dependencies from the pinned EnergyPlus DataSet into the open model. Requires a complete, unambiguous plan, matching EnergyPlus major/minor version, resolvable references, and conflict-free names. All checks run before a single undoable edit; existing identical objects are reused.',
      inputSchema: datasetImportInput,
    },
    async (args) => {
      try {
        await session.prepare()
        session.summary()
        const plan = await planDatasetImport(args)
        if (plan.truncated) throw new SessionError('Cannot import a truncated DataSet plan. Increase the plan limit or choose a smaller dependency closure.')
        if (plan.references.some((reference) => reference.status === 'ambiguous')) {
          throw new SessionError('Cannot import a DataSet plan with ambiguous IDD references.')
        }
        const result = session.importDatasetObjects(plan.version, plan.objects.map((object) => ({
          class: object.class,
          name: object.name,
          fields: object.fields.map(({ index, value }) => ({ index, value })),
        })))
        return run(() => ({ source: { file: plan.file, version: plan.version, root: plan.root }, ...result }))
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    },
  )

  server.registerTool(
    'read_manual_section',
    {
      description: 'Fetch a version-matched object section from the online EnergyPlus I/O Reference at docs.idfkit.com, paged as plain text. Sends the public object-class documentation URL to that site.',
      inputSchema: manualInput,
    },
    async (args) => {
      try {
        await session.prepare()
        const url = session.describeClass(args.class).docs
        if (!url) throw new SessionError(`No manual URL is available for ${args.class}.`)
        const result = await readManualSection(url, args)
        return run(() => result)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    },
  )

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
