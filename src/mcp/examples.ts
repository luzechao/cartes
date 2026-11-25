import { z } from 'zod'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { parseIdf, type IdfObject } from '../parser/index.js'
import { displayName, loadSchema, slotAt, type Schema } from '../schema/index.js'
import { EXAMPLES } from '../ui/examples.js'
import index from './example-index.json'

export const exampleInput = {
  action: z.enum(['search', 'get_objects']),
  class: z.string().optional().describe('Object class to search for or retrieve.'),
  query: z.string().optional().describe('Words in the example title, description or file name.'),
  example: z.string().optional().describe('Example id returned by search; required for get_objects.'),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().min(0).optional().describe('Search result offset.'),
}

export type ExampleInput = z.output<z.ZodObject<typeof exampleInput>>
export type ExampleLoader = (filename: string, bundled: boolean) => Promise<string>

function assertIndexVersion(): void {
  if (index.version !== ENERGYPLUS_VERSION) {
    throw new Error(`Example index is for EnergyPlus ${index.version}, but cartes uses ${ENERGYPLUS_VERSION}; regenerate the index.`)
  }
}

/** Fetch only an indexed file from the immutable EnergyPlus source commit. */
export async function fetchRemoteExample(filename: string): Promise<string> {
  assertIndexVersion()
  if (!index.files.some((entry) => entry.file === filename)) throw new Error(`Unknown example '${filename}'.`)
  const url = `https://raw.githubusercontent.com/NatLabRockies/EnergyPlus/${index.commit}/testfiles/${encodeURIComponent(filename)}`
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error(`Could not load EnergyPlus example ${filename}: HTTP ${response.status}.`)
  return response.text()
}

function assertVersion(version: string | undefined, name: string): void {
  const match = version?.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
  const [major, minor, patch] = ENERGYPLUS_VERSION.split('.').map(Number)
  if (!match || Number(match[1]) !== major || Number(match[2]) !== minor || (match[3] !== undefined && Number(match[3]) !== patch)) {
    throw new Error(`${name} declares EnergyPlus ${version ?? '(no version)'}, but cartes uses ${ENERGYPLUS_VERSION}.`)
  }
}

export function describeExampleObject(obj: IdfObject, schema: Schema) {
  const type = schema.get(obj.className)
  return {
    class: obj.className,
    name: type?.anon ? '' : (obj.fields[0]?.value ?? ''),
    fields: obj.fields.map((field, index) => {
      const slot = type ? slotAt(type, index) : undefined
      return { index, name: slot ? displayName(slot) : `Field ${index + 1}`, value: field.value }
    }),
  }
}

/** Search the pinned engine-release catalog without loading models; inspect one selected model. */
export async function exampleLibrary(args: ExampleInput, load: ExampleLoader) {
  assertIndexVersion()
  const limit = args.limit ?? 20
  if (args.action === 'get_objects' && (!args.example || !args.class)) {
    throw new Error('get_objects requires an example id and class.')
  }
  const bundledByFile = new Map(EXAMPLES.map((example) => [example.idf, example]))
  const catalog = index.files.map((entry) => {
    const bundled = bundledByFile.get(entry.file)
    return {
      entry,
      id: bundled?.id ?? entry.file,
      title: bundled?.title ?? entry.file,
      description: bundled?.description,
      bundled: bundled !== undefined,
    }
  }).sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.entry.file.localeCompare(b.entry.file))
  const choices = args.example ? catalog.filter((example) => example.id === args.example) : catalog
  if (!choices.length) throw new Error(`Unknown example '${args.example}'.`)
  const query = args.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
  if (args.action === 'search') {
    const classIndex = args.class === undefined ? undefined : index.classes.indexOf(args.class.trim().toLowerCase())
    const matches = choices.flatMap((example) => {
      if (!query.every((word) => `${example.id} ${example.title} ${example.description ?? ''} ${example.entry.file}`.toLowerCase().includes(word))) return []
      const count = classIndex === undefined
        ? example.entry.classes.reduce((total, pair) => total + pair[1]!, 0)
        : (example.entry.classes.find((pair) => pair[0] === classIndex)?.[1] ?? 0)
      if (classIndex !== undefined && !count) return []
      return [{
        id: example.id, title: example.title, ...(example.description ? { description: example.description } : {}),
        file: example.entry.file, version: index.version, source: example.bundled ? 'bundled' : 'github', matchingObjects: count,
      }]
    })
    const queryText = args.query?.trim().toLowerCase()
    if (queryText) {
      const score = (file: string) => {
        const name = file.toLowerCase()
        return name === queryText || name.replace(/\.idf$/, '') === queryText ? 0 : name.startsWith(queryText) ? 1 : 2
      }
      matches.sort((a, b) => score(a.file) - score(b.file))
    }
    const offset = args.offset ?? 0
    return { scope: `EnergyPlus ${index.version} testfiles at ${index.commit}`, total: matches.length, offset, truncated: offset + limit < matches.length, results: matches.slice(offset, offset + limit) }
  }
  const example = choices[0]!
  const text = await load(example.entry.file, example.bundled)
  const doc = parseIdf(text)
  assertVersion(doc.version, example.entry.file)
  const ids = doc.byClass.get(args.class!.trim().toLowerCase()) ?? []
  const schema = await loadSchema(doc.version!)
  if (!schema || schema.version.split('.').slice(0, 2).join('.') !== ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')) {
    throw new Error(`Matching EnergyPlus ${index.version} schema unavailable for example '${example.id}'.`)
  }
  const selected = ids.slice(0, limit).map((id) => doc.objects.get(id)!)
  const dependencies = new Map<string, IdfObject>()
  for (const obj of selected) {
    const type = schema.get(obj.className)
    obj.fields.forEach((field, fieldIndex) => {
      const lists = type ? slotAt(type, fieldIndex)?.def?.ol : undefined
      const value = field.value.trim().toLowerCase()
      if (!lists?.length || !value) return
      for (const candidate of doc.objects.values()) {
        const targetType = schema.get(candidate.className)
        if (!targetType || targetType.anon || candidate.fields[0]?.value.trim().toLowerCase() !== value) continue
        if (targetType.nref?.some((list) => lists.includes(list))) dependencies.set(candidate.id, candidate)
      }
    })
  }
  return {
    scope: `EnergyPlus ${index.version} testfiles at ${index.commit}`,
    results: [{
      id: example.id, file: example.entry.file, version: index.version, source: example.bundled ? 'bundled' : 'github',
      total: ids.length, truncated: ids.length > limit,
      objects: selected.map((obj) => describeExampleObject(obj, schema)),
      dependencies: [...dependencies.values()].slice(0, limit).map((obj) => describeExampleObject(obj, schema)),
      dependenciesTruncated: dependencies.size > limit,
      note: 'Dependencies are direct IDD-declared references only; follow their references separately.',
    }],
  }
}
