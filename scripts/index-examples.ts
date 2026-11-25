/**
 * Generate the searchable catalog from testfiles/ extracted from the pinned EnergyPlus release.
 * Usage: npx tsx scripts/index-examples.ts /path/to/EnergyPlus-.../testfiles
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { z } from 'zod'
import { parseIdf } from '../src/parser/index.js'

const version = '26.1.0'
const commit = '6f2e40d10250a105b49966baa24d843711e61048'
const dir = process.argv[2]
if (!dir) throw new Error('Provide the extracted pinned EnergyPlus testfiles directory.')
if (ENERGYPLUS_VERSION !== version) throw new Error(`Index release ${version} differs from engine ${ENERGYPLUS_VERSION}.`)

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })),
})
const tree = (sha: string) => treeSchema.parse(JSON.parse(execFileSync(
  'gh', ['api', `repos/NatLabRockies/EnergyPlus/git/trees/${sha}`], { encoding: 'utf8' },
)))
const root = tree(commit)
if (root.truncated) throw new Error('Upstream root tree is truncated.')
const source = root.tree.find((entry) => entry.path === 'testfiles' && entry.type === 'tree')
if (!source) throw new Error('The pinned commit has no testfiles tree.')
const inventory = tree(source.sha)
if (inventory.truncated) throw new Error('Upstream testfiles tree is truncated.')
const expected = new Map(inventory.tree.filter((entry) => entry.type === 'blob' && entry.path.endsWith('.idf'))
  .map((entry) => [entry.path, entry.sha]))
const files = readdirSync(dir).filter((name) => name.endsWith('.idf')).sort()
if (!files.length || files.length !== expected.size) throw new Error(`Found ${files.length} IDFs; the pinned release has ${expected.size}.`)
const classes = new Set<string>()
const rows = files.map((file) => {
  const contents = readFileSync(join(dir, file))
  const hash = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex')
  if (expected.get(file) !== hash) throw new Error(`${file} does not match the pinned EnergyPlus commit.`)
  const doc = parseIdf(contents.toString('utf8'))
  if (doc.version?.trim() !== version.split('.').slice(0, 2).join('.')) {
    throw new Error(`${file} declares version ${doc.version ?? '(missing)'}, not ${version}.`)
  }
  if (doc.diagnostics.some((issue) => issue.severity === 'error')) throw new Error(`${file} has IDF parse errors.`)
  const counts = [...doc.byClass].map(([name, ids]) => [name, ids.length] as const)
  for (const [name] of counts) classes.add(name)
  return { file, counts }
})
const names = [...classes].sort()
const positions = new Map(names.map((name, index) => [name, index]))
const index = {
  version,
  commit,
  classes: names,
  files: rows.map(({ file, counts }) => ({
    file,
    classes: counts.map(([name, count]) => [positions.get(name)!, count]),
  })),
}
writeFileSync(new URL('../src/mcp/example-index.json', import.meta.url), `${JSON.stringify(index)}\n`)
console.log(`Indexed ${files.length} EnergyPlus ${version} files at commit ${commit}.`)
