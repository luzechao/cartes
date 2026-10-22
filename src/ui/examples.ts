/**
 * Bundled example models (public/examples/). Each loads the model and fills the Simulate tab's inputs with the
 * weather file and PythonPlugin modules it runs with, so the example simulates in one click.
 */

export interface Example {
  id: string
  title: string
  description: string
  idf: string
  /** Weather file in public/examples/. */
  epw: string
  /** PythonPlugin modules in public/examples/. */
  plugins: string[]
}

export const EXAMPLES: readonly Example[] = [
  {
    id: '5zone',
    title: '5 zones, air-cooled',
    description: 'EnergyPlus 26.1 5ZoneAirCooled: four perimeter zones and a core under a plenum. Annual run, Chicago.',
    idf: '5ZoneAirCooled.idf',
    epw: 'USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw',
    plugins: [],
  },
  {
    id: 'plugin',
    title: 'PythonPlugin: custom output',
    description:
      'EnergyPlus 26.1 PythonPluginCustomOutputVariable: a Python plugin reports the volume-weighted average zone temperature. Design days, Chicago.',
    idf: 'PythonPluginCustomOutputVariable.idf',
    epw: 'USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw',
    plugins: ['PythonPluginCustomOutputVariable.py'],
  },
]

export interface LoadedExample {
  name: string
  text: string
  epw: File
  plugins: File[]
}

/** Fetch an example's files from `<baseUrl>examples/`. */
export async function fetchExample(example: Example, baseUrl: string): Promise<LoadedExample> {
  const get = async (name: string): Promise<Blob> => {
    const response = await fetch(`${baseUrl}examples/${name}`)
    if (!response.ok) throw new Error(`Could not load example file ${name}: HTTP ${response.status}`)
    return response.blob()
  }
  const [idf, epw, ...plugins] = await Promise.all([get(example.idf), get(example.epw), ...example.plugins.map(get)])
  return {
    name: example.idf,
    text: await idf!.text(),
    epw: new File([epw!], example.epw),
    plugins: plugins.map((blob, i) => new File([blob], example.plugins[i]!)),
  }
}
