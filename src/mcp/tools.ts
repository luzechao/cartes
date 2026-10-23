/**
 * The model tools, defined once and served twice: by the stdio MCP server (`server.ts`) and by
 * the in-browser agent (`src/agent/tools.ts`). Each is one `ModelSession` method with a zod
 * input shape, a description written for a language model, and a kind that says how careful a
 * host should be before running it.
 *
 * Nothing here touches the disk or the network, so the registry bundles for the browser. Hosts
 * `await session.prepare({ prose })` before `run`, which loads the full schema the class-level
 * tools need; `run` itself is synchronous, so a tool call is one undo step.
 */
import { z } from 'zod'
import type { ModelSession } from './session.js'

/**
 * - `read` never changes the model.
 * - `edit` changes it; every edit is one undo step.
 * - `destructive` removes objects or replaces the model.
 */
export type ToolKind = 'read' | 'edit' | 'destructive'

export interface SessionTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  kind: ToolKind
  /** Omitted for tools without arguments. */
  input?: S
  /** Served by the MCP server only — not offered to the in-app agent. */
  mcpOnly?: boolean
  /** Needs the schema's field notes and class memos loaded (`prepare({ prose: true })`). */
  prose?: boolean
  run: (session: ModelSession, args: z.objectOutputType<S, z.ZodTypeAny>) => unknown
}

function define<S extends z.ZodRawShape>(tool: SessionTool<S>): SessionTool {
  return tool as unknown as SessionTool
}

const point = z.tuple([z.number(), z.number()])
const value = z.union([z.string(), z.number()])
const cls = z.string().optional().describe('Class of the object, when its name is shared with an object of another class.')

export const sessionTools: SessionTool[] = [
  define({
    name: 'new_model',
    kind: 'destructive',
    mcpOnly: true,
    description:
      'Start a new, runnable model: simulation control, a location with design days, geometry rules and a small ' +
      'construction library. No zones yet — add them with extrude_zone.',
    run: (s) => s.newModel(),
  }),
  define({
    name: 'summary',
    kind: 'read',
    description: 'Counts, errors and warnings for the open model.',
    run: (s) => s.summary(),
  }),
  define({
    name: 'list_objects',
    kind: 'read',
    description:
      'Without a class: every class in the file with its object count. With a class (e.g. "Material", ' +
      '"RunPeriod"): the names of its objects, to pass to inspect or set_field.',
    input: {
      class: z.string().optional(),
      limit: z.number().int().positive().optional().describe('Most names to return; default 200.'),
    },
    run: (s, a) => s.listObjects(a.class, a.limit),
  }),
  define({
    name: 'find_classes',
    kind: 'read',
    prose: true,
    description:
      'Search every EnergyPlus class — not only those in the file — by words in its name or IDD group, e.g. ' +
      '"infiltration", "material glazing", "schedule". Returns names, groups and one-line summaries.',
    input: { query: z.string(), limit: z.number().int().positive().optional() },
    run: (s, a) => s.findClasses(a.query, a.limit),
  }),
  define({
    name: 'describe_class',
    kind: 'read',
    prose: true,
    description:
      'Every field of a class, in order: index, epJSON name, type, units, default, choices, bounds, required, the ' +
      'reference lists it must name an object from, and a note; plus any repeating group. Read this before add_object.',
    input: { class: z.string() },
    run: (s, a) => s.describeClass(a.class),
  }),
  define({
    name: 'list_zones',
    kind: 'read',
    description: 'Every zone, with its floor area and origin.',
    run: (s) => s.listZones(),
  }),
  define({
    name: 'list_surfaces',
    kind: 'read',
    description:
      'Every surface — optionally of one zone — with type, construction, boundary condition, area and world vertices (metres, z up).',
    input: { zone: z.string().optional() },
    run: (s, a) => s.listSurfaces(a.zone),
  }),
  define({
    name: 'inspect',
    kind: 'read',
    description: 'Every field of one object of any class: index, name, value and units.',
    input: { name: z.string(), class: cls },
    run: (s, a) => s.inspect(a.name, a.class),
  }),
  define({
    name: 'validate',
    kind: 'read',
    description:
      'Geometry and reference checks as EnergyPlus would raise them, then field checks over every class: choices, ' +
      'numbers, bounds, required fields, dangling references (E009) and duplicate singletons.',
    run: (s) => s.validate(),
  }),
  define({
    name: 'set_field',
    kind: 'edit',
    description:
      'Set one field of any object, by name ("Construction Name" or construction_name) or index. Values the schema ' +
      'forbids are refused with the reason. Unnamed singletons such as Timestep are addressed by class. Use ' +
      'rename_object, not this, to change a name.',
    input: { object: z.string(), field: z.union([z.string(), z.number().int()]), value, class: cls },
    run: (s, a) => s.setField(a.object, a.field, a.value, a.class),
  }),
  define({
    name: 'update_object',
    kind: 'edit',
    description: 'Set several fields of one object at once — all or none, as one undo step. Fields by name or index.',
    input: { object: z.string(), fields: z.record(z.string(), value), class: cls },
    run: (s, a) => s.updateObject(a.object, a.fields, a.class),
  }),
  define({
    name: 'add_object',
    kind: 'edit',
    description:
      'Add an object of any class (call describe_class first). `fields` by name; omitted fields take EnergyPlus ' +
      'defaults. A repeating tail — vertices, Schedule:Compact lines, list entries — goes in `extensible`, one inner ' +
      'array per group in the group’s field order. Refused, with reasons, if a value or required field is wrong. ' +
      'For zones, walls, windows and doors prefer extrude_zone and add_opening.',
    input: {
      class: z.string(),
      name: z.string().optional(),
      fields: z.record(z.string(), value).optional(),
      extensible: z.array(z.array(value)).optional(),
      after: z.string().optional().describe('Place after the object with this name; default: after the last of its class.'),
    },
    run: (s, a) => s.addObject({ className: a.class, name: a.name, fields: a.fields, extensible: a.extensible, after: a.after }),
  }),
  define({
    name: 'rename_object',
    kind: 'edit',
    description:
      'Rename an object and update every field that refers to it by name. Plain-text mentions (e.g. Output:Variable ' +
      'keys) are listed but not changed.',
    input: { object: z.string(), new_name: z.string(), class: cls },
    run: (s, a) => s.renameObject(a.object, a.new_name, a.class),
  }),
  define({
    name: 'duplicate_object',
    kind: 'edit',
    description: 'Copy an object under a new name, placed after it — e.g. a construction or schedule to vary. Not for surfaces.',
    input: { object: z.string(), new_name: z.string(), class: cls },
    run: (s, a) => s.duplicateObject(a.object, a.new_name, a.class),
  }),
  define({
    name: 'remove_object',
    kind: 'destructive',
    description:
      'Delete one object. Refused while other objects refer to it, listing them; with force it is deleted anyway and ' +
      'they are left dangling. Surfaces are deleted with delete_surface.',
    input: { object: z.string(), class: cls, force: z.boolean().optional() },
    run: (s, a) => s.removeObject(a.object, a.class, a.force),
  }),
  define({
    name: 'extrude_zone',
    kind: 'edit',
    description:
      'Create a zone from a plan outline: one wall per edge, a floor and a flat roof. Footprint in world metres, either ' +
      'winding. Constructions default to the file’s own. Walls are created exposed — call propose_matches afterwards to ' +
      'pair any that touch a neighbour.',
    input: {
      name: z.string(),
      footprint: z.array(point).min(3),
      height: z.number().positive(),
      base_z: z.number().optional(),
      constructions: z.object({ wall: z.string(), floor: z.string(), roof: z.string() }).partial().optional(),
    },
    run: (s, a) =>
      s.extrudeZone({
        name: a.name,
        footprint: a.footprint,
        height: a.height,
        ...(a.base_z !== undefined ? { baseZ: a.base_z } : {}),
        ...(a.constructions ? { constructions: a.constructions } : {}),
      }),
  }),
  define({
    name: 'add_opening',
    kind: 'edit',
    description:
      'Put a rectangular window or door on a wall, roof or floor. Refused, with the reason, if it would not fit. On an ' +
      'interzone wall the matching opening is made on the other side too.',
    input: {
      surface: z.string(),
      type: z.enum(['Window', 'Door', 'GlassDoor']).optional(),
      width: z.number().positive(),
      height: z.number().positive(),
      sill: z.number().min(0),
      offset: z.number().optional().describe('From the left edge seen from outside; omit to centre.'),
      construction: z.string().optional(),
    },
    run: (s, a) =>
      s.addOpening({
        surface: a.surface,
        width: a.width,
        height: a.height,
        sill: a.sill,
        ...(a.type ? { type: a.type } : {}),
        ...(a.offset !== undefined ? { offset: a.offset } : {}),
        ...(a.construction ? { construction: a.construction } : {}),
      }),
  }),
  define({
    name: 'move_zone',
    kind: 'edit',
    description: 'Translate a whole zone by a world offset in metres. Reports interzone pairs it pulls apart.',
    input: { zone: z.string(), dx: z.number(), dy: z.number(), dz: z.number() },
    run: (s, a) => s.moveZone(a.zone, a.dx, a.dy, a.dz),
  }),
  define({
    name: 'delete_surface',
    kind: 'destructive',
    description:
      'Delete a surface and its windows and doors. An interzone twin is left dangling (EnergyPlus will not run) unless ' +
      'twin is "adiabatic".',
    input: { name: z.string(), twin: z.enum(['leave', 'adiabatic']).optional() },
    run: (s, a) => s.deleteSurface(a.name, a.twin),
  }),
  define({
    name: 'propose_matches',
    kind: 'read',
    description:
      'Find surfaces that are face to face across zones and propose interzone pairings, with the exact field changes. ' +
      'Changes nothing. Declared pairs and deliberate boundaries are never proposed for change.',
    run: (s) => s.proposeMatches(),
  }),
  define({
    name: 'apply_matches',
    kind: 'edit',
    description: 'Apply proposals from the last propose_matches — all of them, or those whose ids are given.',
    input: { ids: z.array(z.string()).optional() },
    run: (s, a) => s.applyMatches(a.ids),
  }),
  define({
    name: 'convert_simplified',
    kind: 'edit',
    description:
      'Rewrite EnergyPlus’s simplified surface classes (Wall:Exterior, Window, Shading:Overhang, …) with explicit vertices, ' +
      'computed as EnergyPlus computes them. Returns any behaviour that will change.',
    run: (s) => s.convertSimplified(),
  }),
  define({ name: 'undo', kind: 'edit', description: 'Undo the last edit.', run: (s) => s.undo() }),
  define({ name: 'redo', kind: 'edit', description: 'Redo the last undone edit.', run: (s) => s.redo() }),
  define({
    name: 'diff',
    kind: 'read',
    description: 'A unified diff of every change since the file was opened.',
    run: (s) => s.diff(),
  }),
]
