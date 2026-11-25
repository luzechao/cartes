import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createCartesServer } from '../../src/mcp/server.js'
import { runEnergyPlus, zoneInfo } from '../harness/energyplus.js'
import { canRun, exe, FIXTURES } from '../harness/gate-fixtures.js'

/**
 * The MCP server, exercised through the protocol itself: a real MCP client connected over an
 * in-memory transport, calling tools by name with JSON arguments — exactly what an LLM host
 * does. The workflow test ends with the saved file running in EnergyPlus.
 */

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createCartesServer().connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  return client
}

interface Call {
  text: string
  json: () => any
  isError: boolean
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Call> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = r.content[0]!.text
  return { text, json: () => JSON.parse(text), isError: r.isError === true }
}

const dir = mkdtempSync(join(tmpdir(), 'cartes-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('MCP server', () => {
  it('lists its tools, each with a description', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_ideal_loads',
        'add_object',
        'add_outputs',
        'add_opening',
        'apply_matches',
        'check_readiness',
        'convert_simplified',
        'dataset_library',
        'delete_surface',
        'describe_class',
        'diagnose_energyplus_errors',
        'diff',
        'duplicate_object',
        'example_library',
        'import_dataset',
        'extrude_zone',
        'find_classes',
        'find_objects',
        'get_field_reference',
        'get_skill',
        'get_simulation_settings',
        'inspect',
        'inspect_schedule',
        'inspect_hvac_topology',
        'inspect_loads',
        'inspect_loop_structure',
        'inspect_parameter',
        'list_objects',
        'list_skills',
        'list_surfaces',
        'list_zones',
        'move_zone',
        'new_model',
        'open_idf',
        'propose_matches',
        'read_manual_section',
        'redo',
        'remove_object',
        'rename_object',
        'save_idf',
        'scale_compact_schedule',
        'search_reference',
        'scale_loads',
        'set_simulation_settings',
        'set_constant_schedule',
        'set_dual_setpoints',
        'set_field',
        'set_glazing_optics',
        'set_hourly_schedule',
        'set_parameter',
        'summary',
        'undo',
        'update_object',
        'validate',
      ].sort(),
    )
    for (const t of tools) expect(t.description, t.name).toBeTruthy()
    const extrude = tools.find((t) => t.name === 'extrude_zone')!
    expect(extrude.inputSchema.required).toEqual(expect.arrayContaining(['name', 'footprint', 'height']))
  })

  it('reports readiness checks without pretending the IDF contains weather selection', async () => {
    const client = await connect()
    await call(client, 'new_model')
    const report = (await call(client, 'check_readiness')).json()
    expect(report.model).toMatchObject({ zones: 0, surfaces: 0 })
    expect(report.validation).toMatchObject({ errors: 0, warnings: 0, omitted: 0 })
    expect(report.checks).toMatchObject({
      siteLocation: { present: true },
      designDays: { count: 2 },
      zones: { count: 0, withoutFloorArea: [] },
      weatherFile: { status: 'host-managed' },
    })
  })

  it('searches the pinned DataSets catalog over MCP without a model', async () => {
    const client = await connect()
    const result = await call(client, 'dataset_library', { action: 'search', query: 'boilers' })
    expect(result.isError, result.text).toBe(false)
    expect(result.json()).toMatchObject({ results: [expect.objectContaining({ file: 'Boilers.idf', version: '26.1.0' })] })
    const invalid = await call(client, 'dataset_library', { action: 'get_objects', dataset: '../outside.idf', class: 'Boiler:HotWater' })
    expect(invalid.isError).toBe(true)
    const importWithoutModel = await call(client, 'import_dataset', {
      dataset: 'Boilers.idf', class: 'Material', name: 'Brick',
    })
    expect(importWithoutModel.isError).toBe(true)
    expect(importWithoutModel.text).toContain('No model')
  })

  it('returns candidate HVAC flow directions through MCP', async () => {
    const client = await connect()
    await call(client, 'open_idf', { path: 'public/examples/5ZoneAirCooled.idf' })
    const result = await call(client, 'inspect_hvac_topology', { limit: 1000 })
    expect(result.isError, result.text).toBe(false)
    expect(result.json().directedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'Main Heating Coil 1 Outlet Node',
        from: expect.objectContaining({ name: 'Main Heating Coil 1', direction: 'outlet' }),
        to: expect.objectContaining({ name: 'Supply Fan 1', direction: 'inlet' }),
      }),
    ]))
  })

  it('searches and inspects bundled examples without replacing the open model', async () => {
    const client = await connect()
    await call(client, 'new_model')
    const found = (await call(client, 'example_library', { action: 'search', class: 'People' })).json()
    expect(found.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: '5zone' })]))
    const details = (await call(client, 'example_library', { action: 'get_objects', example: '5zone', class: 'People', limit: 1 })).json()
    expect(details.results[0].objects).toHaveLength(1)
    expect(details.results[0].dependencies.length).toBeGreaterThan(0)
    expect((await call(client, 'summary')).json().name).toBe('untitled.idf')
    expect((await call(client, 'example_library', { action: 'get_objects', example: 'missing', class: 'People' })).isError).toBe(true)
  })

  it('searches the pinned catalog and downloads only a selected example', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Version, 26.1; Zone, Sample;', { status: 200 }))
    try {
      const client = await connect()
      const search = await call(client, 'example_library', { action: 'search', query: '1ZoneUncontrolled', class: 'Zone', limit: 1 })
      expect(search.json().results[0]).toMatchObject({ id: '1ZoneUncontrolled.idf', version: '26.1.0', source: 'github' })
      expect(fetch).not.toHaveBeenCalled()
      const detail = await call(client, 'example_library', { action: 'get_objects', example: '1ZoneUncontrolled.idf', class: 'Zone' })
      expect(detail.isError, detail.text).toBe(false)
      expect(detail.json().results[0]).toMatchObject({ total: 1, objects: [expect.objectContaining({ name: 'Sample' })] })
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      fetch.mockRestore()
    }
  })

  it('offers diagnosis and example-learning procedures', async () => {
    const client = await connect()
    const list = (await call(client, 'list_skills')).json()
    expect(list.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['diagnose-simulation-errors', 'learn-from-examples']))
    const skill = (await call(client, 'get_skill', { name: 'diagnose-simulation-errors' })).json()
    expect(skill.steps.join(' ')).toContain('first severe')
  })

  it('returns a fetched manual section through MCP', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<h2 id="windowmaterialsimpleglazingsystem">Simple glazing</h2><p>Documentation text.</p><h2>Next</h2>',
      { status: 200 },
    ))
    try {
      const client = await connect()
      await call(client, 'new_model')
      const result = await call(client, 'read_manual_section', { class: 'WindowMaterial:SimpleGlazingSystem' })
      expect(result.isError, result.text).toBe(false)
      expect(result.json().text).toContain('Documentation text.')
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      fetch.mockRestore()
    }
  })

  it('adds ideal loads through MCP and validates the resulting model', async () => {
    const client = await connect()
    await call(client, 'new_model')
    await call(client, 'extrude_zone', { name: 'Office', footprint: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 3 })
    const added = await call(client, 'add_ideal_loads', { zone: 'Office', heating_setpoint: 19, cooling_setpoint: 25 })
    expect(added.isError, added.text).toBe(false)
    expect(added.json()).toMatchObject({ zone: 'Office', created: expect.arrayContaining(["ZoneHVAC:IdealLoadsAirSystem 'Cartes Office Ideal Loads'"]) })
    expect((await call(client, 'inspect', { name: 'Cartes Office Heating Setpoint' })).json().fields.at(-1).value).toBe('19')
    expect((await call(client, 'inspect', { name: 'Cartes Office Cooling Setpoint' })).json().fields.at(-1).value).toBe('25')
    expect((await call(client, 'validate')).json()).toEqual([])
  })

  it('refuses usefully: no model open, a window that does not fit, a bad path', async () => {
    const client = await connect()
    expect(await call(client, 'summary')).toMatchObject({ isError: true, text: expect.stringMatching(/No model is open/) })
    await call(client, 'new_model')
    await call(client, 'extrude_zone', { name: 'Z', footprint: [[0, 0], [4, 0], [4, 4], [0, 4]], height: 3 })
    const big = await call(client, 'add_opening', { surface: 'Z Wall 1', width: 5, height: 1, sill: 1 })
    expect(big).toMatchObject({ isError: true, text: expect.stringMatching(/extends outside Z Wall 1/) })
    expect(await call(client, 'save_idf', { path: join(dir, 'x.txt') })).toMatchObject({ isError: true })
    expect(await call(client, 'inspect', { name: 'Nope' })).toMatchObject({ isError: true, text: "No object named 'Nope'." })
  })

  it('authors a two-story model end to end, and EnergyPlus runs the saved file', async () => {
    const client = await connect()
    await call(client, 'new_model')
    for (const [name, fp, z] of [
      ['West', [[0, 0], [6, 0], [6, 5], [0, 5]], 0],
      ['East', [[6, 0], [10, 0], [10, 5], [6, 5]], 0],
      ['Upper', [[0, 0], [6, 0], [6, 5], [0, 5]], 3],
    ] as const) {
      const r = await call(client, 'extrude_zone', { name, footprint: fp, height: 3, base_z: z })
      expect(r.isError, r.text).toBe(false)
    }

    const proposals = (await call(client, 'propose_matches')).json()
    expect(proposals.map((p: { surfaces: string[] }) => p.surfaces.join(' / ')).sort()).toEqual([
      'West Roof / Upper Floor',
      'West Wall 2 / East Wall 4',
    ])
    expect((await call(client, 'apply_matches')).json()).toEqual({ applied: 2, changedObjects: 4 })

    for (const wall of ['West Wall 1', 'East Wall 1', 'Upper Wall 1']) {
      expect((await call(client, 'add_opening', { surface: wall, width: 2, height: 1.5, sill: 0.9 })).isError).toBe(false)
    }
    const door = (await call(client, 'add_opening', { surface: 'West Wall 2', type: 'Door', width: 0.9, height: 2.1, sill: 0 })).json()
    expect(door.created).toHaveLength(2) // and its twin, through the shared wall

    expect((await call(client, 'validate')).json()).toEqual([])
    expect((await call(client, 'list_zones')).json().map((z: { name: string; floorArea: number }) => [z.name, z.floorArea])).toEqual([
      ['West', 30],
      ['East', 20],
      ['Upper', 30],
    ])

    // Undo and redo go through the same history the UI uses.
    expect((await call(client, 'undo')).json()).toEqual({ undid: 'Create door' })
    expect((await call(client, 'redo')).json()).toEqual({ redid: 'Create door' })

    const path = join(dir, 'authored.idf')
    const saved = (await call(client, 'save_idf', { path })).json()
    expect(saved.path).toBe(path)

    if (canRun) {
      const run = runEnergyPlus(exe!, readFileSync(path, 'utf8'), { workdir: 'mcp/authored' })
      expect(run.severes, run.err).toEqual([])
      expect(run.completed, run.err).toBe(true)
      expect(run.warnings).toEqual([])
      expect(zoneInfo(run.eio).map((z) => [z.name, z.floorArea, z.volume])).toEqual([
        ['WEST', 30, 90],
        ['EAST', 20, 60],
        ['UPPER', 30, 90],
      ])
    }
  }, 120_000)

  it.skipIf(!canRun)('opens a shipped file, edits and undoes back to the original bytes, and converts simplified surfaces', async () => {
    const client = await connect()
    const path = join(FIXTURES, '4ZoneWithShading_Simple_1.idf')
    const opened = (await call(client, 'open_idf', { path })).json()
    expect(opened.surfaces).toBe(0)
    expect(opened.simplifiedNotDrawn['wall:exterior']).toBe(12)

    const conv = (await call(client, 'convert_simplified')).json()
    expect(conv).toMatchObject({ converted: 43, created: 45, refused: [] })
    expect(conv.notes[0]).toMatch(/Ceiling:Interzone/)
    expect((await call(client, 'summary')).json()).toMatchObject({ surfaces: 45, simplifiedNotDrawn: {} })

    await call(client, 'set_field', { object: 'Zn001:Wall001', field: 'Construction Name', value: 'INTERIOR' })
    await call(client, 'undo')
    await call(client, 'undo')
    expect((await call(client, 'diff')).json()).toEqual({ added: 0, deleted: 0, unified: '' })
  })
})
