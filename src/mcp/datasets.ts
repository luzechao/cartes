import { z } from 'zod'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { parseIdf, type IdfObject } from '../parser/index.js'
import { loadSchema, slotAt, type Schema } from '../schema/index.js'
import { describeExampleObject } from './examples.js'
import index from './dataset-index.json'

export const datasetInput = {
  action: z.enum(['search', 'list_classes', 'get_objects', 'plan_import']),
  query: z.string().optional().describe('Words in the dataset filename.'),
  dataset: z.string().optional().describe('Dataset filename returned by search; required for get_objects.'),
  class: z.string().optional().describe('Object class to retrieve; required for get_objects.'),
  name: z.string().optional().describe('Exact object name; required for plan_import.'),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().min(0).optional(),
  max_objects: z.number().int().positive().max(200).optional().describe('Maximum dependency objects in a plan; defaults to 100.'),
}

export const datasetImportInput = {
  dataset: z.string().describe('Dataset filename returned by dataset_library search.'),
  class: z.string().describe('EnergyPlus class of the object to import.'),
  name: z.string().describe('Exact object name in the DataSet.'),
  max_objects: z.number().int().positive().max(50).optional().describe('Maximum dependency objects to import; defaults to 50.'),
}

type DatasetInput = z.output<z.ZodObject<typeof datasetInput>>
export type DatasetImportInput = z.output<z.ZodObject<typeof datasetImportInput>>
export type DatasetImportPlan = {
  scope: string
  file: string
  version: string
  root: { class: string; name: string }
  objects: Array<ReturnType<typeof describeExampleObject>>
  references: Array<{
    from: { class: string; name: string }
    field: string
    referenceLists: string[]
    name: string
    status: 'included' | 'not_in_dataset' | 'ambiguous' | 'limit'
    candidates?: Array<{ class: string; name: string }>
  }>
  truncated: boolean
  remaining: number
  note: string
  diagnostics: ReturnType<typeof parseIdf>['diagnostics']
  diagnosticsTruncated: boolean
}

function assertIndexVersion() {
  if (index.version !== ENERGYPLUS_VERSION) {
    throw new Error(`DataSets index is for EnergyPlus ${index.version}, but cartes uses ${ENERGYPLUS_VERSION}; regenerate the index.`)
  }
}

function entryFor(name: string) {
  const entry = index.files.find((file) => file.file === name)
  if (!entry) throw new Error(`Unknown DataSet '${name}'.`)
  return entry
}

function planImport(doc: ReturnType<typeof parseIdf>, schema: Schema, className: string, objectName: string, maxObjects: number) {
  const canonical = schema.resolve(className)
  if (!canonical) throw new Error(`EnergyPlus ${schema.version} has no class '${className}'.`)
  const roots = (doc.byClass.get(canonical.toLowerCase()) ?? [])
    .map((id) => doc.objects.get(id)!)
    .filter((obj) => obj.fields[0]?.value.trim().toLowerCase() === objectName.trim().toLowerCase())
  if (!roots.length) throw new Error(`No '${objectName}' object of class ${canonical} exists in this DataSet.`)
  if (roots.length > 1) throw new Error(`'${objectName}' is ambiguous in class ${canonical} in this DataSet.`)

  const referenceClasses = new Map<string, string[]>()
  for (const candidateClass of schema.typeNames) {
    const type = schema.get(candidateClass)
    for (const refList of type?.nref ?? []) {
      const key = refList.toLowerCase()
      referenceClasses.set(key, [...(referenceClasses.get(key) ?? []), candidateClass])
    }
  }
  const byClassAndName = new Map<string, IdfObject[]>()
  for (const object of doc.objects.values()) {
    const type = schema.get(object.className)
    if (!type || type.anon) continue
    const objectName = object.fields[0]?.value.trim()
    if (!objectName) continue
    const key = `${object.className.toLowerCase()}\0${objectName.toLowerCase()}`
    byClassAndName.set(key, [...(byClassAndName.get(key) ?? []), object])
  }

  const queue: IdfObject[] = [roots[0]!]
  const queued = new Set([roots[0]!.id])
  const limited = new Set<string>()
  const included = new Set<string>()
  let omitted = 0
  let referenceLimitReached = false
  const references: Array<{
    from: { class: string; name: string }; field: string; referenceLists: string[]; name: string
    status: 'included' | 'not_in_dataset' | 'ambiguous' | 'limit'
    candidates?: Array<{ class: string; name: string }>
  }> = []
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const object = queue[cursor]!
    if (included.size >= maxObjects) break
    included.add(object.id)
    const type = schema.get(object.className)
    if (!type) continue
    for (let i = 0; i < object.fields.length; i++) {
      const slot = slotAt(type, i)
      const name = object.fields[i]!.value.trim()
      if (!name || !slot?.def?.ol?.length) continue
      if (references.length >= 1000) {
        referenceLimitReached = true
        break
      }
      const candidates = [...new Map(slot.def.ol.flatMap((referenceList) =>
        (referenceClasses.get(referenceList.toLowerCase()) ?? [])
          .flatMap((targetClass) => byClassAndName.get(`${targetClass.toLowerCase()}\0${name.toLowerCase()}`) ?? []),
      ).map((candidate) => [candidate.id, candidate])).values()]
      const source = { class: object.className, name: object.fields[0]?.value.trim() ?? '' }
      if (candidates.length === 1) {
        const target = candidates[0]!
        const ref: (typeof references)[number] = {
          from: source, field: slot.key, referenceLists: slot.def.ol, name, status: 'included',
        }
        references.push(ref)
        if (limited.has(target.id)) {
          ref.status = 'limit'
        } else if (!queued.has(target.id)) {
          if (queue.length < maxObjects) queue.push(target)
          else {
            limited.add(target.id)
            ref.status = 'limit'
            omitted++
          }
          if (ref.status !== 'limit') queued.add(target.id)
        }
      } else if (candidates.length > 1) {
        references.push({
          from: source, field: slot.key, referenceLists: slot.def.ol, name, status: 'ambiguous',
          candidates: candidates.map((candidate) => ({
            class: candidate.className, name: candidate.fields[0]?.value.trim() ?? '',
          })),
        })
      } else {
        references.push({ from: source, field: slot.key, referenceLists: slot.def.ol, name, status: 'not_in_dataset' })
      }
    }
    if (referenceLimitReached) break
  }
  const truncated = queue.length > included.size || omitted > 0 || referenceLimitReached
  const root = roots[0]!
  return {
    root: { class: root.className, name: root.fields[0]?.value.trim() ?? '' },
    objects: queue.slice(0, included.size).map((obj) => describeExampleObject(obj, schema)),
    references,
    truncated,
    remaining: Math.max(0, queue.length - included.size) + omitted,
    note: 'This is only the dependency closure found inside the pinned DataSet. References absent here may already exist in the target model or require a different source. Use import_dataset to import a complete, compatible plan; planning does not edit the model.',
  }
}

export async function fetchRemoteDataset(name: string): Promise<string> {
  assertIndexVersion()
  const entry = entryFor(name)
  const url = `https://raw.githubusercontent.com/NatLabRockies/EnergyPlus/${index.commit}/datasets/${encodeURIComponent(entry.file)}`
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error(`Could not load EnergyPlus DataSet ${name}: HTTP ${response.status}.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.size) throw new Error(`DataSet '${name}' has an unexpected size.`)
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const blob = new Uint8Array(header.length + bytes.length)
  blob.set(header)
  blob.set(bytes, header.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', blob))
  const sha = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (sha !== entry.sha) throw new Error(`DataSet '${name}' does not match the pinned EnergyPlus source.`)
  return new TextDecoder().decode(bytes)
}

export async function planDatasetImport(
  args: DatasetImportInput,
  load: (name: string) => Promise<string> = fetchRemoteDataset,
): Promise<DatasetImportPlan> {
  assertIndexVersion()
  const entry = entryFor(args.dataset)
  const doc = parseIdf(await load(entry.file))
  const schema = await loadSchema(index.version)
  if (!schema || schema.version.split('.').slice(0, 2).join('.') !== ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')) {
    throw new Error(`Matching EnergyPlus ${index.version} schema unavailable for DataSet '${entry.file}'.`)
  }
  return {
    scope: `EnergyPlus ${index.version} datasets at ${index.commit}`,
    file: entry.file,
    version: index.version,
    ...planImport(doc, schema, args.class, args.name, args.max_objects ?? 50),
    diagnostics: doc.diagnostics.slice(0, 20),
    diagnosticsTruncated: doc.diagnostics.length > 20,
  }
}

export async function datasetLibrary(args: DatasetInput, load: (name: string) => Promise<string> = fetchRemoteDataset) {
  assertIndexVersion()
  const limit = args.limit ?? 20
  const offset = args.offset ?? 0
  const scope = `EnergyPlus ${index.version} datasets at ${index.commit}`
  if (args.action === 'search') {
    const words = args.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const files = index.files.filter((entry) => words.every((word) => entry.file.toLowerCase().includes(word)))
    return {
      scope, total: files.length, offset, truncated: offset + limit < files.length,
      results: files.slice(offset, offset + limit).map(({ file, size }) => ({ file, size, version: index.version })),
      note: 'Search covers filenames, not object classes or contents; inspecting a file downloads it from GitHub.',
    }
  }
  if (args.action === 'plan_import') {
    if (!args.dataset) throw new Error('plan_import requires a dataset filename.')
    if (!args.class) throw new Error('plan_import requires a class.')
    if (!args.name?.trim()) throw new Error('plan_import requires an exact object name.')
    return planDatasetImport({
      dataset: args.dataset, class: args.class, name: args.name, max_objects: args.max_objects,
    }, load)
  }
  if (!args.dataset) throw new Error(`${args.action} requires a dataset filename.`)
  if (args.action === 'get_objects' && !args.class) throw new Error('get_objects requires a class.')
  const entry = entryFor(args.dataset)
  const doc = parseIdf(await load(entry.file))
  const classes = [...doc.byClass].map(([className, objects]) => ({ class: className, count: objects.length }))
    .sort((a, b) => a.class.localeCompare(b.class))
  if (args.action === 'list_classes') {
    return {
      scope, file: entry.file, version: index.version, total: classes.length, offset, truncated: offset + limit < classes.length,
      classes: classes.slice(offset, offset + limit), diagnostics: doc.diagnostics.slice(0, 20), diagnosticsTruncated: doc.diagnostics.length > 20,
      note: 'Source is pinned to the engine release; library contents can still require adaptation and validation, and may reference other objects or files.',
    }
  }
  const schema = await loadSchema(index.version)
  if (!schema || schema.version.split('.').slice(0, 2).join('.') !== ENERGYPLUS_VERSION.split('.').slice(0, 2).join('.')) {
    throw new Error(`Matching EnergyPlus ${index.version} schema unavailable for DataSet '${entry.file}'.`)
  }
  const ids = doc.byClass.get(args.class!.trim().toLowerCase()) ?? []
  return {
    scope, file: entry.file, version: index.version, total: ids.length, offset, truncated: offset + limit < ids.length,
    objects: ids.slice(offset, offset + limit).map((id) => describeExampleObject(doc.objects.get(id)!, schema)),
    diagnostics: doc.diagnostics.slice(0, 20), diagnosticsTruncated: doc.diagnostics.length > 20,
    note: 'Source is pinned to the engine release; library contents can still require adaptation and validation, and may reference other objects or files.',
  }
}
