import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { localBundle } from '@idfkit/schemas/node'
import {
  describeClass,
  findClasses,
  loadSchema,
  pickSchemaVersion,
  schemaIssues,
  setSchemaBundle,
  slotAt,
  slotIndex,
  valueProblem,
  type Schema,
} from '../../src/schema/index.js'
import { ModelSession, SessionError } from '../../src/mcp/session.js'
import { LATEST_IDD_VERSION, newModelSource } from '../../src/model/index.js'

setSchemaBundle(localBundle())

const EXAMPLE = readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8')

let schema: Schema
beforeAll(async () => {
  schema = (await loadSchema('26.1'))!
})

describe('full schema', () => {
  it('reads a file with its own release, else the newest older one', () => {
    const v = ['8.9.0', '9.6.0', '22.1.0', '26.1.0', '26.2.0']
    expect(pickSchemaVersion('26.1', v)).toBe('26.1.0')
    expect(pickSchemaVersion('22.2', v)).toBe('22.1.0')
    expect(pickSchemaVersion('27.1', v)).toBe('26.2.0')
    expect(pickSchemaVersion('8.5', v)).toBeUndefined()
  })

  it('maps IDF positions to fields, through the repeating group', () => {
    const surface = schema.get('BuildingSurface:Detailed')!
    expect(slotAt(surface, 0)?.key).toBe('name')
    expect(slotAt(surface, 5)?.key).toBe('outside_boundary_condition')
    expect(slotAt(surface, 17)).toMatchObject({ key: 'vertex_x_coordinate', group: 3 })
    expect(slotIndex(surface, 'Outside Boundary Condition Object')).toBe(6)
    expect(slotIndex(surface, 'Vertex 3 X-coordinate')).toBe(17)
    expect(slotIndex(surface, 'vertex_3_x_coordinate')).toBe(17)
    expect(slotIndex(schema.get('Construction')!, 'Layer 2')).toBe(2)
    expect(slotIndex(schema.get('Schedule:Compact')!, 'Field 5')).toBe(6)
  })

  it('checks values as EnergyPlus reads them', () => {
    const material = schema.get('Material')!
    expect(valueProblem(material.p.roughness, 'smooth')).toBeUndefined()
    expect(valueProblem(material.p.roughness, 'Glossy')).toMatch(/must be one of .*MediumRough/)
    expect(valueProblem(material.p.conductivity, '0')).toMatch(/greater than 0/)
    expect(valueProblem(material.p.conductivity, 'abc')).toBe('must be a number')
    expect(valueProblem(material.p.solar_absorptance, 1.2)).toMatch(/at most 1/)
    expect(valueProblem(schema.get('Timestep')!.p.number_of_timesteps_per_hour, '4.5')).toMatch(/whole number/)
    const flow = schema.get('Sizing:Zone')!
    const auto = Object.values(flow.p).find((d) => d.auto && d.se?.includes('Autosize'))
    if (auto) expect(valueProblem(auto, 'Autocalculate')).toBeUndefined()
  })

  it('finds nothing wrong with EnergyPlus’s own example or a new model', () => {
    expect(schemaIssues(EXAMPLE, schema).filter((i) => i.severity === 'error')).toEqual([])
    expect(schemaIssues(newModelSource(LATEST_IDD_VERSION), schema)).toEqual([])
  })

  it('describes and searches every class', () => {
    const d = describeClass(schema, 'material')!
    expect(d.class).toBe('Material')
    expect(d.name).toBe('required')
    expect(d.fields[0]).toMatchObject({ index: 1, name: 'roughness', required: true })
    expect(d.fields.find((f) => f.name === 'conductivity')).toMatchObject({ units: 'W/m-K', exclusiveMin: 0 })
    expect(describeClass(schema, 'BuildingSurface:Detailed')!.extensible?.startsAt).toBe(11)
    const found = findClasses(schema, 'infiltration design')
    expect(found.matches.map((m) => m.class)).toContain('ZoneInfiltration:DesignFlowRate')
  })
})

describe('session: any class', () => {
  async function open(): Promise<ModelSession> {
    const s = new ModelSession()
    s.openText(EXAMPLE, '5ZoneAirCooled.idf')
    await s.prepare({ prose: true })
    return s
  }

  it('names every field of classes outside the geometry table', async () => {
    const s = await open()
    const infil = s.inspect('SPACE1-1 Infil 1')
    expect(infil.class).toBe('ZoneInfiltration:DesignFlowRate')
    expect(infil.fields[4]).toMatchObject({ name: 'Design Flow Rate', value: '0.032', units: 'm3/s' })
  })

  it('refuses values the schema forbids, with the reason', async () => {
    const s = await open()
    expect(() => s.setField('WD01', 'Roughness', 'Glossy')).toThrow(/must be one of/)
    expect(() => s.updateObject('WD01', { conductivity: -1, density: 500 })).toThrow(/Nothing changed: Conductivity must be greater than 0/)
    expect(s.updateObject('WD01', { conductivity: 0.2, 'Specific Heat': 1300 })).toEqual({
      object: "Material 'WD01'",
      changed: ['Conductivity', 'Specific Heat'],
    })
  })

  it('adds objects of any class, repeating groups included', async () => {
    const s = await open()
    expect(() => s.addObject({ className: 'Material', name: 'Cork', fields: { roughness: 'Rough' } })).toThrow(
      /required field\(s\) missing: thickness, conductivity, density, specific_heat/,
    )
    expect(() => s.addObject({ className: 'Material', name: 'WD01', fields: {} })).toThrow(/already has that name/)
    expect(
      s.addObject({
        className: 'material',
        name: 'Cork',
        fields: { roughness: 'Rough', thickness: 0.05, conductivity: 0.04, density: 120, specific_heat: 1800 },
      }),
    ).toEqual({ created: "Material 'Cork'", fields: 6 })
    s.addObject({
      className: 'Schedule:Compact',
      name: 'Office Occupancy',
      fields: { schedule_type_limits_name: 'Fraction' },
      extensible: [['Through: 12/31'], ['For: AllDays'], ['Until: 24:00'], [1]],
    })
    expect(s.inspect('Office Occupancy').fields.map((f) => f.value)).toEqual(['Office Occupancy', 'Fraction', 'Through: 12/31', 'For: AllDays', 'Until: 24:00', '1'])
    expect(s.text()).toMatch(/Cork,\s+!- Name\n\s+Rough,\s+!- Roughness/)
    expect(s.validate().filter((i) => i.severity === 'error')).toEqual([])
  })

  it('renames through every reference, as one undo step', async () => {
    const s = await open()
    const r = s.renameObject('WD01', 'Wood Siding')
    expect(r.updatedReferences).toEqual(["Construction 'ROOF-1': Layer 4", "Construction 'WALL-1': Outside Layer"])
    expect(s.inspect('WALL-1').fields[1]!.value).toBe('Wood Siding')
    expect(s.undo()).toEqual({ undid: 'Rename Material' })
    expect(s.inspect('WALL-1').fields[1]!.value).toBe('WD01')
  })

  it('renames a zone, carrying its surfaces with it', async () => {
    const s = await open()
    const r = s.renameObject('SPACE1-1', 'Office', 'Zone')
    expect(r.updatedReferences.length).toBeGreaterThan(6)
    expect(s.listZones().map((z) => z.name)).toContain('Office')
    expect(s.listSurfaces('Office').length).toBeGreaterThan(0)
    expect(s.validate().filter((i) => i.severity === 'error')).toEqual([])
  })

  it('refuses to delete what is referred to, unless forced', async () => {
    const s = await open()
    expect(() => s.removeObject('WD01')).toThrow(/Not deleted: 2 field\(s\) refer to Material 'WD01'/)
    const r = s.removeObject('WD01', undefined, true)
    expect(r.danglingReferences).toHaveLength(2)
    expect(s.validate().filter((i) => i.code === 'E009').map((i) => i.object)).toEqual(['ROOF-1', 'WALL-1'])
    expect(() => s.removeObject('WALL-1', 'Construction')).toThrow(/refer to Construction 'WALL-1'/)
    expect(() => s.removeObject('WALL-1PF')).toThrow(/delete_surface/)
  })

  it('duplicates, and never matches unnamed objects by their first field', async () => {
    const s = await open()
    expect(s.duplicateObject('WALL-1', 'WALL-2')).toEqual({ created: "Construction 'WALL-2'" })
    expect(s.inspect('WALL-2').fields.slice(1).map((f) => f.value)).toEqual(s.inspect('WALL-1').fields.slice(1).map((f) => f.value))
    expect(() => s.inspect('*')).toThrow(SessionError)
  })
})
