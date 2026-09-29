import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
        'add_opening',
        'apply_matches',
        'convert_simplified',
        'delete_surface',
        'diff',
        'extrude_zone',
        'inspect',
        'list_surfaces',
        'list_zones',
        'move_zone',
        'new_model',
        'open_idf',
        'propose_matches',
        'redo',
        'save_idf',
        'set_field',
        'summary',
        'undo',
        'validate',
      ].sort(),
    )
    for (const t of tools) expect(t.description, t.name).toBeTruthy()
    const extrude = tools.find((t) => t.name === 'extrude_zone')!
    expect(extrude.inputSchema.required).toEqual(expect.arrayContaining(['name', 'footprint', 'height']))
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

  it('authors a two-storey model end to end, and EnergyPlus runs the saved file', async () => {
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
