import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { localBundle } from '@idfkit/schemas/node'
import { loadBundledIndex } from '@idfkit/weather/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { ModelSession } from '../../src/mcp/session.js'
import { designDayNames, proxied, searchStations, setStationIndexLoader } from '../../src/weather/index.js'

setSchemaBundle(localBundle())
setStationIndexLoader(() => loadBundledIndex())

const EXAMPLE = readFileSync('public/examples/5ZoneAirCooled.idf', 'utf8')

async function open(): Promise<ModelSession> {
  const s = new ModelSession()
  s.openText(EXAMPLE, '5ZoneAirCooled.idf')
  await s.prepare()
  return s
}

/** A made-up station in the layout climate.onebuilding.org's DDY files use. */
const DDY = `
 Site:Location,
  Testville_XX_ZZZ Design_Conditions,     !- Location Name
      40.00,     !- Latitude {N+ S-}
     -90.00,     !- Longitude {W- E+}
      -6.00,     !- Time Zone Relative to GMT {GMT+/-}
     200.00;     !- Elevation {m}

 SizingPeriod:DesignDay,
  Testville Ann Htg 99.6% Condns DB,     !- Name
          1,      !- Month
         21,      !- Day of Month
  WinterDesignDay,!- Day Type
      -20.0,      !- Maximum Dry-Bulb Temperature {C}
        0.0,      !- Daily Dry-Bulb Temperature Range {C}
 DefaultMultipliers, !- Dry-Bulb Temperature Range Modifier Type
           ,      !- Dry-Bulb Temperature Range Modifier Day Schedule Name
    Wetbulb,      !- Humidity Condition Type
      -20.0,      !- Wetbulb at Maximum Dry-Bulb {C}
           ,      !- Humidity Indicating Day Schedule Name
           ,      !- Humidity Ratio at Maximum Dry-Bulb {kgWater/kgDryAir}
           ,      !- Enthalpy at Maximum Dry-Bulb {J/kg}
           ,      !- Daily Wet-Bulb Temperature Range {deltaC}
     99000.,      !- Barometric Pressure {Pa}
        5.0,      !- Wind Speed {m/s}
        270,      !- Wind Direction {Degrees; N=0, S=180}
         No,      !- Rain {Yes/No}
         No,      !- Snow on ground {Yes/No}
         No,      !- Daylight Savings Time Indicator
  ASHRAEClearSky, !- Solar Model Indicator
           ,      !- Beam Solar Day Schedule Name
           ,      !- Diffuse Solar Day Schedule Name
           ,      !- ASHRAE Clear Sky Optical Depth for Beam Irradiance (taub)
           ,      !- ASHRAE Clear Sky Optical Depth for Diffuse Irradiance (taud)
       0.00;      !- Clearness {0.0 to 1.1}

 SizingPeriod:DesignDay,
  Testville Ann Clg .4% Condns DB=>MWB,     !- Name
          7,      !- Month
         21,      !- Day of Month
  SummerDesignDay,!- Day Type
       33.0,      !- Maximum Dry-Bulb Temperature {C}
       11.0,      !- Daily Dry-Bulb Temperature Range {C}
 DefaultMultipliers, !- Dry-Bulb Temperature Range Modifier Type
           ,      !- Dry-Bulb Temperature Range Modifier Day Schedule Name
    Wetbulb,      !- Humidity Condition Type
       23.0,      !- Wetbulb at Maximum Dry-Bulb {C}
           ,      !- Humidity Indicating Day Schedule Name
           ,      !- Humidity Ratio at Maximum Dry-Bulb {kgWater/kgDryAir}
           ,      !- Enthalpy at Maximum Dry-Bulb {J/kg}
           ,      !- Daily Wet-Bulb Temperature Range {deltaC}
     99000.,      !- Barometric Pressure {Pa}
        5.0,      !- Wind Speed {m/s}
        230,      !- Wind Direction {Degrees; N=0, S=180}
         No,      !- Rain {Yes/No}
         No,      !- Snow on ground {Yes/No}
         No,      !- Daylight Savings Time Indicator
  ASHRAETau,      !- Solar Model Indicator
           ,      !- Beam Solar Day Schedule Name
           ,      !- Diffuse Solar Day Schedule Name
      0.450,      !- ASHRAE Clear Sky Optical Depth for Beam Irradiance (taub)
      2.200;      !- ASHRAE Clear Sky Optical Depth for Diffuse Irradiance (taud)

 SizingPeriod:DesignDay,
  Testville January .4% Condns DB=>MCWB,     !- Name
          1,      !- Month
         21,      !- Day of Month
  SummerDesignDay;!- Day Type
`

describe('simulation settings', () => {
  it('reads and changes time step, run period and SimulationControl as one undo step', async () => {
    const s = await open()
    const before = s.simulationSettings()
    expect(before.timestep).toBe(4)
    expect(before.runPeriods[0]).toMatchObject({ name: 'Run Period 1', begin_month: '1', end_month: '12', end_day_of_month: '31' })
    expect(before.designDays).toHaveLength(2)
    expect(() => s.setSimulationSettings({ timestep: 7 })).toThrow(/divides 60/)
    expect(() => s.setSimulationSettings({ runPeriod: { beginMonth: 2, beginDay: 30, endMonth: 3, endDay: 1 } })).toThrow(/2\/30 is not a date/)
    expect(() => s.setSimulationSettings({ simulationControl: { run_simulation_for_sizing_periods: 'Maybe' } })).toThrow(/must be one of/)
    const r = s.setSimulationSettings({
      timestep: 6,
      runPeriod: { beginMonth: 7, beginDay: 1, endMonth: 7, endDay: 31 },
      simulationControl: { run_simulation_for_sizing_periods: 'Yes' },
    })
    expect(r.changed).toEqual(['Timestep 6', 'RunPeriod 7/1–7/31', 'SimulationControl Run Simulation for Sizing Periods Yes'])
    expect(s.simulationSettings().runPeriods[0]).toMatchObject({ begin_month: '7', end_month: '7' })
    expect(s.undo()).toEqual({ undid: 'Simulation settings' })
    expect(s.simulationSettings().timestep).toBe(4)
    expect(s.simulationSettings().runPeriods[0]).toMatchObject({ begin_month: '1', end_month: '12' })
    expect(s.validate().filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('loads', () => {
  it('reports the value each method uses, per floor area', async () => {
    const s = await open()
    const { loads, zoneFloorAreas } = s.inspectLoads('SPACE1-1')
    expect(zoneFloorAreas['SPACE1-1']).toBeCloseTo(99.16, 1)
    const people = loads.find((l) => l.class === 'People')!
    expect(people).toMatchObject({ target: 'SPACE1-1', method: 'people', value: 11 })
    expect(people.perFloorArea!.value).toBeCloseTo(11 / 99.16, 3)
    const infil = loads.find((l) => l.class === 'ZoneInfiltration:DesignFlowRate')!
    expect(infil).toMatchObject({ method: 'flow/zone', value: 0.032, units: 'm3/s' })
    expect(loads.map((l) => l.class)).toEqual(expect.arrayContaining(['Lights', 'ElectricEquipment']))
  })

  it('scales whichever field the method reads, as one undo step', async () => {
    const s = await open()
    const r = s.scaleLoads({ className: 'zoneinfiltration:designflowrate', factor: 1.5 })
    expect(r.changed).toHaveLength(5)
    expect(r.changed[0]).toBe("ZoneInfiltration:DesignFlowRate 'SPACE1-1 Infil 1': Design Flow Rate 0.032 → 0.048")
    expect(s.inspect('SPACE1-1 Infil 1').fields[4]!.value).toBe('0.048')
    const lights = s.scaleLoads({ className: 'Lights', factor: 0.5, zone: 'SPACE2-1' })
    expect(lights.changed).toHaveLength(1)
    expect(s.undo()).toEqual({ undid: 'Scale Lights' })
    expect(() => s.scaleLoads({ className: 'Material', factor: 2 })).toThrow(/works on People/)
  })
})

describe('outputs', () => {
  it('adds variables and meters once', async () => {
    const s = await open()
    const r = s.addOutputs({ variables: [{ name: 'Zone Air Temperature' }, { name: 'Zone Mean Radiant Temperature', key: 'SPACE1-1' }], meters: ['Electricity:Facility'], frequency: 'hourly' })
    expect(r.alreadyRequested).toEqual(['Zone Air Temperature (*, Hourly)'])
    expect(r.added).toEqual(['Output:Variable Zone Mean Radiant Temperature (SPACE1-1, Hourly)', 'Output:Meter Electricity:Facility (Hourly)'])
    expect(s.addOutputs({ meters: ['Electricity:Facility'], frequency: 'Hourly' }).added).toEqual([])
    expect(() => s.addOutputs({ meters: ['x'], frequency: 'Fortnightly' })).toThrow(/Reporting frequency must be one of/)
  })
})

describe('design conditions from a weather file', () => {
  it('replaces the design days and the location', async () => {
    const s = await open()
    const r = s.applyDesignConditions(DDY)
    expect(r.removed).toHaveLength(2)
    expect(r.added).toEqual(['Testville Ann Htg 99.6% Condns DB', 'Testville Ann Clg .4% Condns DB=>MWB'])
    expect(r.location).toBe('Testville_XX_ZZZ Design_Conditions (40.00, -90.00; UTC-6.00; 200.00 m)')
    expect(s.simulationSettings().designDays).toEqual(r.added)
    expect(s.validate().filter((i) => i.severity === 'error')).toEqual([])
    expect(() => s.applyDesignConditions(DDY, { designDays: ['Clg 2%'] })).toThrow(/no design day matching/)
    expect(designDayNames(DDY)).toEqual(['Testville Ann Htg 99.6% Condns DB', 'Testville Ann Clg .4% Condns DB=>MWB'])
  })
})

describe('weather stations', () => {
  beforeAll(() => searchStations({ query: 'warm up' }).catch(() => {}), 30_000)

  it('finds a city once, as its newest TMYx variant', async () => {
    // Cities that start with the query come before those that contain it (Port Chicago, CA).
    const found = await searchStations({ query: 'Chicago' })
    expect(found.slice(0, 3).every((f) => /^Chicago .*, IL, USA$/.test(f.name))).toBe(true)
    const ohare = (await searchStations({ query: 'Chicago OHare' }))[0]!
    expect(ohare.id).toMatch(/^USA_IL_Chicago\.OHare\.Intl\.AP\.725300_TMYx\.\d{4}-\d{4}$/)
    expect(ohare.otherVariants!.length).toBeGreaterThan(1)
    expect(ohare.climateZone).toMatch(/^5A/)
    expect(new Set(found.map((f) => f.wmo + f.name)).size).toBe(found.length)
  })

  it('finds the stations nearest a point', async () => {
    const near = await searchStations({ latitude: 41.98, longitude: -87.9, limit: 3 })
    expect(near[0]!.wmo).toBe('725300')
    expect(near[0]!.distanceKm).toBeLessThan(5)
    expect(new Set(near.map((n) => n.wmo)).size).toBe(near.length)
  })

  it('routes downloads through a proxy', () => {
    expect(proxied('')).toBeUndefined()
    expect(proxied('https://p.example/?url={url}')!('https://a/b c.zip')).toBe('https://p.example/?url=https%3A%2F%2Fa%2Fb%20c.zip')
    expect(proxied('https://p.example/')!('https://a/b.zip')).toBe('https://p.example/https://a/b.zip')
  })
})
