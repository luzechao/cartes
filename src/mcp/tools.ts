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
import { diagnoseEnergyPlusErrors, skills } from './skills.js'

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
  run: (session: ModelSession, args: z.output<z.ZodObject<S>>) => unknown
}

function define<S extends z.ZodRawShape>(tool: SessionTool<S>): SessionTool {
  return tool as unknown as SessionTool
}

const point = z.tuple([z.number(), z.number()])
const value = z.union([z.string(), z.number()])
const cls = z.string().optional().describe('Class of the object, when its name is shared with an object of another class.')
export const parameter = z.enum([
  'window_u_factor', 'window_shgc', 'cooling_cop', 'heating_cop', 'heating_efficiency', 'fan_efficiency',
  'water_heater_efficiency', 'water_heater_on_parasitic', 'water_heater_off_parasitic',
  'water_heater_on_loss', 'water_heater_off_loss', 'water_use_peak_flow',
  'outdoor_air_per_person', 'outdoor_air_per_area', 'outdoor_air_per_zone',
])

export const sessionTools: SessionTool[] = [
  define({
    name: 'list_skills',
    kind: 'read',
    description: 'List the available EnergyPlus modeling and diagnosis procedures.',
    run: () => Object.entries(skills).map(([name, skill]) => ({ name, description: skill.description })),
  }),
  define({
    name: 'get_skill',
    kind: 'read',
    description: 'Read an EnergyPlus modeling or diagnosis procedure and its steps.',
    input: { name: z.enum(['diagnose-simulation-errors', 'learn-from-examples']) },
    run: (_s, a) => ({ name: a.name, ...skills[a.name] }),
  }),
  define({
    name: 'diagnose_energyplus_errors',
    kind: 'read',
    description: 'Extract severe and fatal records from supplied EnergyPlus error text and give tentative offline investigation prompts. These are not automatic diagnoses or fixes; inspect the complete log and model.',
    input: { text: z.string().max(80000).describe('EnergyPlus eplusout.err text or selected lines; no network request is made.') },
    run: (_s, a) => diagnoseEnergyPlusErrors(a.text),
  }),
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
    name: 'check_readiness',
    kind: 'read',
    description:
      'A pre-simulation snapshot: validation issues, location, design days, run periods, zones without floor area, ' +
      'and internal load counts. Weather is managed by the host and cannot be inferred from the IDF.',
    run: (s) => s.checkReadiness(),
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
    name: 'search_reference',
    kind: 'read',
    prose: true,
    description:
      'Search the loaded EnergyPlus IDD class and field names, notes and memos. Returns paged matches and links to the ' +
      'manual where available; does not search the full manuals.',
    input: { query: z.string(), limit: z.number().int().positive().max(100).optional(), offset: z.number().int().min(0).optional() },
    run: (s, a) => s.searchReference(a.query, a.limit, a.offset),
  }),
  define({
    name: 'get_field_reference',
    kind: 'read',
    prose: true,
    description: 'Get an IDD field’s full note, constraints and manual link for the loaded schema version. Does not retrieve the manual text.',
    input: { class: z.string(), field: z.string() },
    run: (s, a) => s.fieldReference(a.class, a.field),
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
    name: 'find_objects',
    kind: 'read',
    description:
      'Find objects by class pattern (use * as a wildcard), exact whole-field name, or object-name substring. ' +
      'Matches include fields using a NodeList containing the requested name. Text matches are evidence, not necessarily IDD-declared references.',
    input: {
      class_pattern: z.string().optional(),
      name: z.string().optional(),
      name_contains: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    run: (s, a) => s.findObjects({ classPattern: a.class_pattern, name: a.name, nameContains: a.name_contains, limit: a.limit }),
  }),
  define({
    name: 'inspect_hvac_topology',
    kind: 'read',
    description:
      'List air, plant and condenser loops and model-wide node-bearing components; group shared nodes and expand NodeLists. ' +
      'Candidate directed connections match an outlet field to an inlet field on the same node; ambiguous fields remain unknown. ' +
      'Candidates are not validated flow paths. An optional loop selects loop fields, not components.',
    input: { loop: z.string().optional(), limit: z.number().int().positive().max(1000).optional() },
    run: (s, a) => s.inspectHvacTopology(a),
  }),
  define({
    name: 'inspect_loop_structure',
    kind: 'read',
    description: 'Inspect one air, plant or condenser loop’s BranchLists, ordered branch components and splitter/mixer declarations. Compare declared component nodes with actual IDD node fields and report mismatches, plus unresolved declarations and a Mermaid branch diagram. This is not a simulation-validated flow path; air-loop demand equipment is not shown.',
    input: { name: z.string(), class: z.enum(['AirLoopHVAC', 'PlantLoop', 'CondenserLoop']) },
    run: (s, a) => s.inspectLoopStructure(a.name, a.class),
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
  define({
    name: 'add_ideal_loads',
    kind: 'edit',
    description:
      'Add idealized heating and cooling to one zone that has no existing HVAC connections or thermostat. Creates ' +
      'constant 20°C heating / 24°C cooling setpoints by default, schedules, thermostat, ideal-loads equipment and ' +
      'zone connections as one undoable edit. This is idealized conditioning for load studies, not a physical HVAC ' +
      'system or a realistic energy-use baseline.',
    input: {
      zone: z.string(),
      heating_setpoint: z.number().optional().describe('Constant heating setpoint in °C; default 20.'),
      cooling_setpoint: z.number().optional().describe('Constant cooling setpoint in °C; default 24 and must exceed heating.'),
    },
    run: (s, a) =>
      s.addIdealLoads({
        zone: a.zone,
        ...(a.heating_setpoint !== undefined ? { heatingSetpoint: a.heating_setpoint } : {}),
        ...(a.cooling_setpoint !== undefined ? { coolingSetpoint: a.cooling_setpoint } : {}),
      }),
  }),
  define({
    name: 'get_simulation_settings',
    kind: 'read',
    description: 'Time step, run periods, SimulationControl flags, Site:Location and design-day names.',
    run: (s) => s.simulationSettings(),
  }),
  define({
    name: 'set_simulation_settings',
    kind: 'edit',
    description:
      'Change the time step (steps per hour, a divisor of 60), a run period’s dates, and SimulationControl flags ' +
      '(e.g. {"run_simulation_for_sizing_periods": "No"}), as one undo step. A missing Timestep or RunPeriod is added.',
    input: {
      timestep: z.number().int().optional(),
      run_period: z
        .object({
          name: z.string().optional().describe('Which run period, when the file has several.'),
          begin_month: z.number().int(),
          begin_day: z.number().int(),
          end_month: z.number().int(),
          end_day: z.number().int(),
        })
        .optional(),
      simulation_control: z.record(z.string(), value).optional(),
    },
    run: (s, a) =>
      s.setSimulationSettings({
        timestep: a.timestep,
        runPeriod: a.run_period && {
          name: a.run_period.name,
          beginMonth: a.run_period.begin_month,
          beginDay: a.run_period.begin_day,
          endMonth: a.run_period.end_month,
          endDay: a.run_period.end_day,
        },
        simulationControl: a.simulation_control,
      }),
  }),
  define({
    name: 'inspect_loads',
    kind: 'read',
    description:
      'People, lights, electric/gas/hot-water/steam/other equipment, infiltration and ventilation objects: target ' +
      'zone or list, schedule, calculation method, the value that method uses, and its per-floor-area equivalent. ' +
      'Also every zone’s floor area.',
    input: { zone: z.string().optional() },
    run: (s, a) => s.inspectLoads(a.zone),
  }),
  define({
    name: 'inspect_schedule',
    kind: 'read',
    description: 'Inspect a schedule, its direct references and textual mentions, and an IDD-declared reference graph through other schedules.',
    input: { name: z.string(), class: cls },
    run: (s, a) => s.inspectSchedule(a.name, a.class),
  }),
  define({
    name: 'set_constant_schedule',
    kind: 'edit',
    description:
      'Set a Schedule:Constant value, respecting its ScheduleTypeLimits. Inspect first; when it has any references or ' +
      'textual mentions, acknowledge_shared must explicitly be true. The change affects all users of the schedule.',
    input: { name: z.string(), value: z.number(), acknowledge_shared: z.boolean().optional() },
    run: (s, a) => s.setConstantSchedule(a.name, a.value, a.acknowledge_shared),
  }),
  define({
    name: 'scale_compact_schedule',
    kind: 'edit',
    description:
      'Multiply all Until values in a Schedule:Compact by a positive factor. Requires explicit ScheduleTypeLimits; ' +
      'refuses unsupported fields or values outside the limits, without changing anything. Inspect and acknowledge ' +
      'all shared uses first.',
    input: { name: z.string(), factor: z.number().positive(), acknowledge_shared: z.boolean().optional() },
    run: (s, a) => s.scaleCompactSchedule(a.name, a.factor, a.acknowledge_shared),
  }),
  define({
    name: 'set_hourly_schedule',
    kind: 'edit',
    description: 'Replace all 24 values of a Schedule:Day:Hourly within its ScheduleTypeLimits, atomically. Inspect the schedule and explicitly acknowledge its references and textual mentions first.',
    input: { name: z.string(), values: z.array(z.number()).length(24), acknowledge_shared: z.boolean().optional() },
    run: (s, a) => s.setHourlySchedule(a.name, a.values, a.acknowledge_shared),
  }),
  define({
    name: 'set_dual_setpoints',
    kind: 'edit',
    description: 'Set both heating and cooling temperatures in °C for a ThermostatSetpoint:DualSetpoint, only when each uses a distinct Schedule:Constant. Heating must be below cooling. Inspect both schedules and explicitly acknowledge all references and textual mentions; the change affects all their users.',
    input: { name: z.string(), heating: z.number(), cooling: z.number(), acknowledge_shared: z.boolean().optional() },
    run: (s, a) => s.setDualSetpoints(a.name, a.heating, a.cooling, a.acknowledge_shared),
  }),
  define({
    name: 'set_glazing_optics',
    kind: 'edit',
    description: 'Replace six user-supplied normal-incidence solar and visible transmittance/reflectance values on a WindowMaterial:Glazing using SpectralAverage. Values must be physically consistent. This is not an automatic film calculation. Inspect and acknowledge all shared uses first.',
    input: {
      name: z.string(),
      solar_transmittance: z.number(), solar_front_reflectance: z.number(), solar_back_reflectance: z.number(),
      visible_transmittance: z.number(), visible_front_reflectance: z.number(), visible_back_reflectance: z.number(),
      acknowledge_shared: z.boolean().optional(),
    },
    run: (s, a) => s.setGlazingOptics(a.name, {
      solarTransmittance: a.solar_transmittance, solarFrontReflectance: a.solar_front_reflectance, solarBackReflectance: a.solar_back_reflectance,
      visibleTransmittance: a.visible_transmittance, visibleFrontReflectance: a.visible_front_reflectance, visibleBackReflectance: a.visible_back_reflectance,
    }, a.acknowledge_shared),
  }),
  define({
    name: 'inspect_parameter',
    kind: 'read',
    description: 'Inspect a supported semantic parameter and its direct references: selected glazing, coils, fans, mixed/stratified water heaters, WaterUse:Equipment peak flow, and DesignSpecification:OutdoorAir flow rates. Outdoor-air rates depend on the object’s calculation method.',
    input: { parameter, name: z.string(), class: cls },
    run: (s, a) => s.inspectParameter(a.parameter, a.name, a.class),
  }),
  define({
    name: 'set_parameter',
    kind: 'edit',
    description:
      'Set one supported semantic parameter to an absolute value in its documented units. Inspect the parameter first; ' +
      'editing a shared object affects every use. Unsupported classes and invalid values are refused.',
    input: { parameter, name: z.string(), value: z.number(), class: cls },
    run: (s, a) => s.setParameter(a.parameter, a.name, a.value, a.class),
  }),
  define({
    name: 'scale_loads',
    kind: 'edit',
    description:
      'Multiply the loads of one class (People, Lights, ElectricEquipment, GasEquipment, HotWaterEquipment, ' +
      'SteamEquipment, OtherEquipment, ZoneInfiltration:DesignFlowRate, ZoneVentilation:DesignFlowRate) by a factor — ' +
      'whichever field each object’s calculation method uses — optionally for one zone or named objects. One undo step.',
    input: { class: z.string(), factor: z.number().positive(), zone: z.string().optional(), names: z.array(z.string()).optional() },
    run: (s, a) => s.scaleLoads({ className: a.class, factor: a.factor, zone: a.zone, names: a.names }),
  }),
  define({
    name: 'add_outputs',
    kind: 'edit',
    description:
      'Request output variables (Output:Variable, key "*" for all) and meters (Output:Meter) at a reporting ' +
      'frequency (Timestep, Hourly, Daily, Monthly, RunPeriod…). Already-requested ones are skipped. Names come ' +
      'from list_output_variables.',
    input: {
      variables: z.array(z.object({ name: z.string(), key: z.string().optional() })).optional(),
      meters: z.array(z.string()).optional(),
      frequency: z.string(),
    },
    run: (s, a) => s.addOutputs({ variables: a.variables, meters: a.meters, frequency: a.frequency }),
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
