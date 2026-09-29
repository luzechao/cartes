/**
 * A minimal, runnable starting file for authoring from scratch — Phase 8.
 *
 * Everything EnergyPlus needs before the first zone exists: simulation control, a location with
 * one heating and one cooling design day (so the file runs without a weather file, as the gate
 * harness runs it), geometry rules, and a small construction library covering what the creation
 * tools produce — exterior and interior walls, a roof, a ground floor, an interior slab, a window
 * and a door. Interior constructions are layer-symmetric, because EnergyPlus expects the two sides
 * of an interzone surface to carry reversed constructions and a symmetric one is its own reverse.
 *
 * Values are generic and deliberately round; they are a starting point to replace, not a
 * recommendation. `Relative` coordinates, so moving a zone is one edit to its origin.
 */

export const TEMPLATE_CONSTRUCTIONS = {
  exteriorWall: 'Exterior Wall',
  interiorWall: 'Interior Wall',
  roof: 'Roof',
  groundFloor: 'Ground Floor',
  interiorSlab: 'Interior Slab',
  window: 'Exterior Window',
  door: 'Exterior Door',
} as const

export function newModelSource(version: string): string {
  return `!- Created by cartes. A starting point: replace the location, design days and
!- constructions with your project's own.

Version,${version};

SimulationControl,
    No,                      !- Do Zone Sizing Calculation
    No,                      !- Do System Sizing Calculation
    No,                      !- Do Plant Sizing Calculation
    Yes,                     !- Run Simulation for Sizing Periods
    No;                      !- Run Simulation for Weather File Run Periods

Building,
    New Building,            !- Name
    0,                       !- North Axis {deg}
    Suburbs,                 !- Terrain
    0.04,                    !- Loads Convergence Tolerance Value {W}
    0.4,                     !- Temperature Convergence Tolerance Value {deltaC}
    FullExterior,            !- Solar Distribution
    25,                      !- Maximum Number of Warmup Days
    6;                       !- Minimum Number of Warmup Days

Timestep,4;

Site:Location,
    Example Site,            !- Name
    40.0,                    !- Latitude {deg}
    -105.0,                  !- Longitude {deg}
    -7.0,                    !- Time Zone {hr}
    1600;                    !- Elevation {m}

SizingPeriod:DesignDay,
    Example Heating Design Day,  !- Name
    1,                       !- Month
    21,                      !- Day of Month
    WinterDesignDay,         !- Day Type
    -15,                     !- Maximum Dry-Bulb Temperature {C}
    0,                       !- Daily Dry-Bulb Temperature Range {deltaC}
    ,                        !- Dry-Bulb Temperature Range Modifier Type
    ,                        !- Dry-Bulb Temperature Range Modifier Day Schedule Name
    Wetbulb,                 !- Humidity Condition Type
    -15,                     !- Wetbulb or DewPoint at Maximum Dry-Bulb {C}
    ,                        !- Humidity Condition Day Schedule Name
    ,                        !- Humidity Ratio at Maximum Dry-Bulb {kgWater/kgDryAir}
    ,                        !- Enthalpy at Maximum Dry-Bulb {J/kg}
    ,                        !- Daily Wet-Bulb Temperature Range {deltaC}
    84000,                   !- Barometric Pressure {Pa}
    4,                       !- Wind Speed {m/s}
    0,                       !- Wind Direction {deg}
    No,                      !- Rain Indicator
    No,                      !- Snow Indicator
    No,                      !- Daylight Saving Time Indicator
    ASHRAEClearSky,          !- Solar Model Indicator
    ,                        !- Beam Solar Day Schedule Name
    ,                        !- Diffuse Solar Day Schedule Name
    ,                        !- ASHRAE Clear Sky Optical Depth for Beam Irradiance (taub) {dimensionless}
    ,                        !- ASHRAE Clear Sky Optical Depth for Diffuse Irradiance (taud) {dimensionless}
    0;                       !- Sky Clearness

SizingPeriod:DesignDay,
    Example Cooling Design Day,  !- Name
    7,                       !- Month
    21,                      !- Day of Month
    SummerDesignDay,         !- Day Type
    33,                      !- Maximum Dry-Bulb Temperature {C}
    15,                      !- Daily Dry-Bulb Temperature Range {deltaC}
    ,                        !- Dry-Bulb Temperature Range Modifier Type
    ,                        !- Dry-Bulb Temperature Range Modifier Day Schedule Name
    Wetbulb,                 !- Humidity Condition Type
    16,                      !- Wetbulb or DewPoint at Maximum Dry-Bulb {C}
    ,                        !- Humidity Condition Day Schedule Name
    ,                        !- Humidity Ratio at Maximum Dry-Bulb {kgWater/kgDryAir}
    ,                        !- Enthalpy at Maximum Dry-Bulb {J/kg}
    ,                        !- Daily Wet-Bulb Temperature Range {deltaC}
    84000,                   !- Barometric Pressure {Pa}
    4,                       !- Wind Speed {m/s}
    180,                     !- Wind Direction {deg}
    No,                      !- Rain Indicator
    No,                      !- Snow Indicator
    No,                      !- Daylight Saving Time Indicator
    ASHRAEClearSky,          !- Solar Model Indicator
    ,                        !- Beam Solar Day Schedule Name
    ,                        !- Diffuse Solar Day Schedule Name
    ,                        !- ASHRAE Clear Sky Optical Depth for Beam Irradiance (taub) {dimensionless}
    ,                        !- ASHRAE Clear Sky Optical Depth for Diffuse Irradiance (taud) {dimensionless}
    1;                       !- Sky Clearness

Site:GroundTemperature:BuildingSurface,
    18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18;  !- January to December {C}

Output:Variable,*,Zone Mean Air Temperature,Hourly;

GlobalGeometryRules,
    UpperLeftCorner,         !- Starting Vertex Position
    Counterclockwise,        !- Vertex Entry Direction
    Relative;                !- Coordinate System

!- ===== Materials and constructions =====

Material,
    Brick 100mm,             !- Name
    Rough,                   !- Roughness
    0.1,                     !- Thickness {m}
    0.89,                    !- Conductivity {W/m-K}
    1920,                    !- Density {kg/m3}
    790;                     !- Specific Heat {J/kg-K}

Material,
    Insulation 50mm,         !- Name
    MediumRough,             !- Roughness
    0.05,                    !- Thickness {m}
    0.035,                   !- Conductivity {W/m-K}
    40,                      !- Density {kg/m3}
    1200;                    !- Specific Heat {J/kg-K}

Material,
    Gypsum 13mm,             !- Name
    Smooth,                  !- Roughness
    0.013,                   !- Thickness {m}
    0.16,                    !- Conductivity {W/m-K}
    800,                     !- Density {kg/m3}
    1090;                    !- Specific Heat {J/kg-K}

Material,
    Roof Membrane 10mm,      !- Name
    VeryRough,               !- Roughness
    0.01,                    !- Thickness {m}
    0.16,                    !- Conductivity {W/m-K}
    1120,                    !- Density {kg/m3}
    1460;                    !- Specific Heat {J/kg-K}

Material,
    Roof Insulation 100mm,   !- Name
    MediumRough,             !- Roughness
    0.1,                     !- Thickness {m}
    0.035,                   !- Conductivity {W/m-K}
    40,                      !- Density {kg/m3}
    1200;                    !- Specific Heat {J/kg-K}

Material,
    Concrete 150mm,          !- Name
    MediumRough,             !- Roughness
    0.15,                    !- Thickness {m}
    1.9,                     !- Conductivity {W/m-K}
    2240,                    !- Density {kg/m3}
    900;                     !- Specific Heat {J/kg-K}

Material,
    Wood 45mm,               !- Name
    MediumSmooth,            !- Roughness
    0.045,                   !- Thickness {m}
    0.15,                    !- Conductivity {W/m-K}
    600,                     !- Density {kg/m3}
    1630;                    !- Specific Heat {J/kg-K}

WindowMaterial:SimpleGlazingSystem,
    Double Glazing,          !- Name
    2.0,                     !- U-Factor {W/m2-K}
    0.4,                     !- Solar Heat Gain Coefficient
    0.6;                     !- Visible Transmittance

Construction,
    ${TEMPLATE_CONSTRUCTIONS.exteriorWall},           !- Name
    Brick 100mm,             !- Outside Layer
    Insulation 50mm,         !- Layer 2
    Gypsum 13mm;             !- Layer 3

Construction,
    ${TEMPLATE_CONSTRUCTIONS.interiorWall},           !- Name
    Gypsum 13mm,             !- Outside Layer
    Insulation 50mm,         !- Layer 2
    Gypsum 13mm;             !- Layer 3

Construction,
    ${TEMPLATE_CONSTRUCTIONS.roof},                    !- Name
    Roof Membrane 10mm,      !- Outside Layer
    Roof Insulation 100mm,   !- Layer 2
    Gypsum 13mm;             !- Layer 3

Construction,
    ${TEMPLATE_CONSTRUCTIONS.groundFloor},            !- Name
    Concrete 150mm;          !- Outside Layer

Construction,
    ${TEMPLATE_CONSTRUCTIONS.interiorSlab},           !- Name
    Concrete 150mm;          !- Outside Layer

Construction,
    ${TEMPLATE_CONSTRUCTIONS.window},         !- Name
    Double Glazing;          !- Outside Layer

Construction,
    ${TEMPLATE_CONSTRUCTIONS.door},           !- Name
    Wood 45mm;               !- Outside Layer

!- ===== Geometry =====
`
}
