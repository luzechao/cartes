/**
 * The MCP server — Phase 9 of docs/05-implementation-plan.md: "an LLM can drive the scene. A
 * protocol, not a framework."
 *
 * A thin layer: each tool is one `ModelSession` method, its arguments described with zod so the
 * client sees a schema, its result returned as JSON text. Errors the session raises on purpose
 * (a window that does not fit, a name that does not exist) come back as tool errors carrying the
 * reason, which is what lets a model correct itself; anything else is a bug and is rethrown.
 *
 * Nothing touches the disk except `open_idf` (read) and `save_idf` (write, `.idf` only, and only
 * when asked). Every edit is undoable with `undo`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ModelSession, SessionError } from './session.js'

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

const point = z.tuple([z.number(), z.number()])

export function createCartesServer(session = new ModelSession()): McpServer {
  const server = new McpServer({ name: 'cartes', version: '0.9.0' })

  server.registerTool(
    'open_idf',
    { description: 'Open an EnergyPlus .idf file from disk. Replaces any open model.', inputSchema: { path: z.string() } },
    ({ path }) => run(() => session.openFile(path)),
  )
  server.registerTool(
    'new_model',
    {
      description:
        'Start a new, runnable model: simulation control, a location with design days, geometry rules and a small ' +
        'construction library. No zones yet — add them with extrude_zone.',
    },
    () => run(() => session.newModel()),
  )
  server.registerTool('summary', { description: 'Counts, errors and warnings for the open model.' }, () =>
    run(() => session.summary()),
  )
  server.registerTool('list_zones', { description: 'Every zone, with its floor area and origin.' }, () =>
    run(() => session.listZones()),
  )
  server.registerTool(
    'list_surfaces',
    {
      description:
        'Every surface — optionally of one zone — with type, construction, boundary condition, area and world vertices (metres, z up).',
      inputSchema: { zone: z.string().optional() },
    },
    ({ zone }) => run(() => session.listSurfaces(zone)),
  )
  server.registerTool(
    'inspect',
    { description: 'Every field of one object of any class, by IDD field name.', inputSchema: { name: z.string() } },
    ({ name }) => run(() => session.inspect(name)),
  )
  server.registerTool('validate', { description: 'Geometry and reference checks, as EnergyPlus would raise them.' }, () =>
    run(() => session.validate()),
  )
  server.registerTool(
    'set_field',
    {
      description: 'Set one field of any object, by IDD field name (e.g. "Construction Name") or index.',
      inputSchema: { object: z.string(), field: z.union([z.string(), z.number().int()]), value: z.string() },
    },
    ({ object, field, value }) => run(() => session.setField(object, field, value)),
  )
  server.registerTool(
    'extrude_zone',
    {
      description:
        'Create a zone from a plan outline: one wall per edge, a floor and a flat roof. Footprint in world metres, either ' +
        'winding. Constructions default to the file’s own. Walls are created exposed — call propose_matches afterwards to ' +
        'pair any that touch a neighbour.',
      inputSchema: {
        name: z.string(),
        footprint: z.array(point).min(3),
        height: z.number().positive(),
        base_z: z.number().optional(),
        constructions: z.object({ wall: z.string(), floor: z.string(), roof: z.string() }).partial().optional(),
      },
    },
    ({ name, footprint, height, base_z, constructions }) =>
      run(() =>
        session.extrudeZone({
          name,
          footprint,
          height,
          ...(base_z !== undefined ? { baseZ: base_z } : {}),
          ...(constructions ? { constructions } : {}),
        }),
      ),
  )
  server.registerTool(
    'add_opening',
    {
      description:
        'Put a rectangular window or door on a wall, roof or floor. Refused, with the reason, if it would not fit. On an ' +
        'interzone wall the matching opening is made on the other side too.',
      inputSchema: {
        surface: z.string(),
        type: z.enum(['Window', 'Door', 'GlassDoor']).optional(),
        width: z.number().positive(),
        height: z.number().positive(),
        sill: z.number().min(0),
        offset: z.number().optional().describe('From the left edge seen from outside; omit to centre.'),
        construction: z.string().optional(),
      },
    },
    (a) =>
      run(() =>
        session.addOpening({
          surface: a.surface,
          width: a.width,
          height: a.height,
          sill: a.sill,
          ...(a.type ? { type: a.type } : {}),
          ...(a.offset !== undefined ? { offset: a.offset } : {}),
          ...(a.construction ? { construction: a.construction } : {}),
        }),
      ),
  )
  server.registerTool(
    'move_zone',
    {
      description: 'Translate a whole zone by a world offset in metres. Reports interzone pairs it pulls apart.',
      inputSchema: { zone: z.string(), dx: z.number(), dy: z.number(), dz: z.number() },
    },
    ({ zone, dx, dy, dz }) => run(() => session.moveZone(zone, dx, dy, dz)),
  )
  server.registerTool(
    'delete_surface',
    {
      description:
        'Delete a surface and its windows and doors. An interzone twin is left dangling (EnergyPlus will not run) unless ' +
        'twin is "adiabatic".',
      inputSchema: { name: z.string(), twin: z.enum(['leave', 'adiabatic']).optional() },
    },
    ({ name, twin }) => run(() => session.deleteSurface(name, twin)),
  )
  server.registerTool(
    'propose_matches',
    {
      description:
        'Find surfaces that are face to face across zones and propose interzone pairings, with the exact field changes. ' +
        'Changes nothing. Declared pairs and deliberate boundaries are never proposed for change.',
    },
    () => run(() => session.proposeMatches()),
  )
  server.registerTool(
    'apply_matches',
    {
      description: 'Apply proposals from the last propose_matches — all of them, or those whose ids are given.',
      inputSchema: { ids: z.array(z.string()).optional() },
    },
    ({ ids }) => run(() => session.applyMatches(ids)),
  )
  server.registerTool(
    'convert_simplified',
    {
      description:
        'Rewrite EnergyPlus’s simplified surface classes (Wall:Exterior, Window, Shading:Overhang, …) with explicit vertices, ' +
        'computed as EnergyPlus computes them. Returns any behaviour that will change.',
    },
    () => run(() => session.convertSimplified()),
  )
  server.registerTool('undo', { description: 'Undo the last edit.' }, () => run(() => session.undo()))
  server.registerTool('redo', { description: 'Redo the last undone edit.' }, () => run(() => session.redo()))
  server.registerTool('diff', { description: 'A unified diff of every change since the file was opened.' }, () =>
    run(() => session.diff()),
  )
  server.registerTool(
    'save_idf',
    {
      description: 'Write the model to disk. Without a path, overwrites the file it was opened from. Must end in .idf.',
      inputSchema: { path: z.string().optional() },
    },
    ({ path }) => run(() => session.save(path)),
  )

  return server
}
