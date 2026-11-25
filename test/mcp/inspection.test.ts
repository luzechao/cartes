import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { ModelSession } from '../../src/mcp/session.js'

setSchemaBundle(localBundle())

const MODEL = `
Version, 26.1;
NodeList, Zone Inlets, Supply Node, Other Node;
ZoneHVAC:EquipmentConnections, Zone A, Equipment, Zone Inlets, , Return Node, ;
Fan:ConstantVolume, Supply Fan, Always On, 0.7, 500, 1, 0.9, 1, Return Node, Supply Node;
Coil:Heating:Electric, Heat Coil, Always On, 1, 1000, supply node, Coil Out, Supply Node;
Coil:Heating:Water, Water Coil, Always On, 100, 0.1, Water In, Water Out, Coil Out, Discharge;
`

async function open() {
  const session = new ModelSession()
  session.openText(MODEL)
  await session.prepare()
  return session
}

describe('model relationship inspection', () => {
  it('finds exact whole-field matches and NodeList users without changing the model', async () => {
    const s = await open()
    const result = s.findObjects({ name: 'supply node' })
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'ZoneHVAC:EquipmentConnections', matches: expect.arrayContaining([expect.objectContaining({ via: 'Zone Inlets' })]) }),
      expect.objectContaining({ class: 'Fan:ConstantVolume' }),
    ]))
    expect(s.findObjects({ classPattern: 'Fan:*' }).total).toBe(1)
    expect(s.findObjects({ name: 'supply' }).total).toBe(0)
    expect(s.text()).toBe(MODEL)
  })

  it('groups node connections including NodeLists and reports limits', async () => {
    const s = await open()
    const topology = s.inspectHvacTopology()
    expect(topology.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: 'Supply Node', endpoints: expect.arrayContaining([
        expect.objectContaining({ class: 'Fan:ConstantVolume' }),
        expect.objectContaining({ class: 'ZoneHVAC:EquipmentConnections', via: 'Zone Inlets' }),
      ]) }),
    ]))
    expect(() => s.inspectHvacTopology({ loop: 'missing' })).toThrow(/No air, plant or condenser loop/)
    expect(s.inspectHvacTopology({ limit: 1 }).truncated).toBe(true)
  })

  it('identifies outlet-to-inlet candidates without inferring paths through components', async () => {
    const topology = (await open()).inspectHvacTopology()
    expect(topology.directedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'Supply Node',
        from: expect.objectContaining({ name: 'Supply Fan', field: 'Air Outlet Node Name', direction: 'outlet' }),
        to: expect.objectContaining({ name: 'Heat Coil', field: 'Air Inlet Node Name', direction: 'inlet' }),
      }),
      expect.objectContaining({
        node: 'Coil Out',
        from: expect.objectContaining({ name: 'Heat Coil', direction: 'outlet' }),
        to: expect.objectContaining({ name: 'Water Coil', direction: 'inlet' }),
      }),
      expect.objectContaining({
        node: 'Supply Node',
        to: expect.objectContaining({ class: 'ZoneHVAC:EquipmentConnections', direction: 'inlet', via: 'Zone Inlets' }),
      }),
    ]))
    expect(topology.connections.find((connection) => connection.node === 'Supply Node')!.endpoints)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Heat Coil', field: 'Temperature Setpoint Node Name', direction: 'unknown' })]))
    expect(topology.directedConnections.every((link) => link.from.name !== link.to.name)).toBe(true)
    expect(topology.directedConnections.some((link) => link.node === 'Water In' || link.node === 'Water Out')).toBe(false)
    const limited = (await open()).inspectHvacTopology({ limit: 1 })
    expect(limited.directedConnections).toHaveLength(1)
    expect(limited.totalDirectedConnections).toBe(topology.totalDirectedConnections)
    expect(limited.truncated).toBe(true)
  })

  it('does not expand a NodeList for fields that accept only node names or ambiguous list names', async () => {
    const s = new ModelSession()
    s.openText(`${MODEL}
NodeList, Supply Node, Unrelated Node;
NodeList, Zone Inlets, Ambiguous Node;
NodeList, Empty List;
ZoneHVAC:EquipmentConnections, Zone B, Equipment, Empty List, , , ;
`)
    await s.prepare()
    const topology = s.inspectHvacTopology()
    expect(topology.ambiguousNodeLists).toContain('zone inlets')
    expect(topology.emptyNodeLists).toContain('empty list')
    expect(topology.directedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: 'Supply Node', from: expect.objectContaining({ name: 'Supply Fan' }), to: expect.objectContaining({ name: 'Heat Coil' }) }),
    ]))
    expect(topology.directedConnections.some((link) => link.node === 'Unrelated Node' || link.node === 'Ambiguous Node')).toBe(false)
  })

  it('finds a real coil-to-fan connection without treating branch declarations as components', async () => {
    const s = new ModelSession()
    s.openText(readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8'))
    await s.prepare()
    const topology = s.inspectHvacTopology({ loop: 'VAV Sys 1', limit: 1000 })
    expect(topology.directedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'Main Heating Coil 1 Outlet Node',
        from: expect.objectContaining({ class: 'Coil:Heating:Water', name: 'Main Heating Coil 1' }),
        to: expect.objectContaining({ class: 'Fan:VariableVolume', name: 'Supply Fan 1' }),
      }),
    ]))
    expect(topology.directedConnections.every((link) => link.from.class !== 'Branch' && link.to.class !== 'Branch')).toBe(true)
    expect(topology.loops.map((loop) => loop.name)).toEqual(['VAV Sys 1'])
  })

  it('reports selected loop branch declarations, connectors, and unresolved items', async () => {
    const s = new ModelSession()
    s.openText(`Version,26.1;
AirLoopHVAC,Loop,,,,Branches,Connectors;
BranchList,Branches,Supply,Left,Right,Exit,Missing;
Branch,Supply,,Fan:ConstantVolume,Fan,In,Out,Coil:Heating:Electric,Coil,Wrong,Next;
Branch,Left,,Fan:ConstantVolume,Left Fan,L1,L2;
Branch,Right,,Fan:ConstantVolume,Right Fan,R1,R2;
Branch,Exit,,Fan:ConstantVolume,Exit Fan,E1,E2;
Fan:ConstantVolume,Fan;
Fan:ConstantVolume,Left Fan;
Fan:ConstantVolume,Right Fan;
Fan:ConstantVolume,Exit Fan;
ConnectorList,Connectors,Connector:Splitter,Split,Connector:Mixer,Mix;
Connector:Splitter,Split,Supply,Left,Right,Outside;
Connector:Mixer,Mix,Exit,Left,Right;`)
    await s.prepare()
    const result = s.inspectLoopStructure('Loop', 'AirLoopHVAC')
    const side = result.sides[0]!
    expect(side.branches.find((b) => b.name === 'Supply')!.components.map((c) => c.name)).toEqual(['Fan', 'Coil'])
    expect(side.edges).toEqual([
      { from: 'Supply', to: 'Left', connector: 'Split' },
      { from: 'Supply', to: 'Right', connector: 'Split' },
      { from: 'Left', to: 'Exit', connector: 'Mix' },
      { from: 'Right', to: 'Exit', connector: 'Mix' },
    ])
    expect(side.warnings.join(' ')).toMatch(/different connecting nodes/)
    expect(side.warnings.join(' ')).toMatch(/Coil.*missing/)
    expect(side.warnings.join(' ')).toMatch(/Missing.*missing/)
    expect(side.warnings.join(' ')).toMatch(/outside the selected BranchList/)
    expect(side.diagram).toContain('b0 --> b1')
  })

  it('checks branch component node declarations against actual IDD fields', async () => {
    const inspect = async (branchInlet: string, branchOutlet: string) => {
      const s = new ModelSession()
      s.openText(`Version,26.1;
AirLoopHVAC,Loop,,,,Branches,Connectors;
BranchList,Branches,Supply;
Branch,Supply,,Fan:ConstantVolume,Fan,${branchInlet},${branchOutlet};
Fan:ConstantVolume,Fan,Always On,0.7,500,1,0.9,1,In,Out;
`)
      await s.prepare()
      return s.inspectLoopStructure('Loop', 'AirLoopHVAC').sides[0]!
    }

    const matched = await inspect('in', 'OUT')
    expect(matched.branches[0]!.components[0]!.nodeValidation).toMatchObject({
      status: 'matched',
      actual: [
        { field: 'air_inlet_node_name', direction: 'inlet', node: 'In' },
        { field: 'air_outlet_node_name', direction: 'outlet', node: 'Out' },
      ],
    })
    expect(matched.warnings.some((warning) => warning.includes('object fields'))).toBe(false)

    const mismatch = await inspect('Wrong In', 'Wrong Out')
    expect(mismatch.branches[0]!.components[0]!.nodeValidation.status).toBe('mismatch')
    expect(mismatch.warnings.join(' ')).toContain("declares 'Fan' nodes 'Wrong In' → 'Wrong Out'")
    expect(mismatch.warnings.join(' ')).toContain("inlet 'In' (air_inlet_node_name)")

    const blank = await inspect('', 'Out')
    expect(blank.branches[0]!.components[0]!.nodeValidation.status).toBe('mismatch')
    expect(blank.warnings.join(' ')).toContain("declares 'Fan' nodes '' → 'Out'")
  })

  it('finds declared components in a real air loop without including other loops', async () => {
    const s = new ModelSession()
    s.openText(readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8'))
    await s.prepare()
    const result = s.inspectLoopStructure('VAV Sys 1', 'AirLoopHVAC')
    const names = result.sides.flatMap((side) => side.branches.flatMap((branch) => branch.components.map((component) => component.name)))
    expect(names).toContain('Main Heating Coil 1')
    expect(names).toContain('Supply Fan 1')
    expect(names).not.toContain('Supply Fan 2')
  })

  it('separately traces the supply and demand branch declarations of a real plant loop', async () => {
    const s = new ModelSession()
    s.openText(readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8'))
    await s.prepare()
    const result = s.inspectLoopStructure('Hot Water Loop', 'PlantLoop')
    const plant = result.sides.find((side) => side.side === 'plant')!
    const demand = result.sides.find((side) => side.side === 'demand')!
    expect(plant.branches.map((branch) => branch.name)).toContain('Central Boiler Branch')
    expect(demand.branches.map((branch) => branch.name)).toContain('Main Heating Coil 1 Branch')
    expect(plant.branches.map((branch) => branch.name)).not.toContain('Main Heating Coil 1 Branch')
    expect(plant.edges.length).toBeGreaterThan(0)
    expect(demand.edges.length).toBeGreaterThan(0)
    expect([...plant.warnings, ...demand.warnings]).toEqual([])
  })
})
