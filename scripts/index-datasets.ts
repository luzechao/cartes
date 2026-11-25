/**
 * Generate a filename catalog from the pinned EnergyPlus release tree.
 * Usage: npx tsx scripts/index-datasets.ts
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { z } from 'zod'

const version = '26.1.0'
const commit = '6f2e40d10250a105b49966baa24d843711e61048'
if (ENERGYPLUS_VERSION !== version) throw new Error(`Index release ${version} differs from engine ${ENERGYPLUS_VERSION}.`)
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() })),
})
const tree = (sha: string) => treeSchema.parse(JSON.parse(execFileSync(
  'gh', ['api', `repos/NatLabRockies/EnergyPlus/git/trees/${sha}`], { encoding: 'utf8' },
)))
const root = tree(commit)
if (root.truncated) throw new Error('Upstream root tree is truncated.')
const source = root.tree.find((entry) => entry.path === 'datasets' && entry.type === 'tree')
if (!source) throw new Error('The pinned commit has no datasets tree.')
const inventory = tree(source.sha)
if (inventory.truncated) throw new Error('Upstream datasets tree is truncated.')
const files = inventory.tree.filter((entry) => entry.type === 'blob' && entry.path.endsWith('.idf'))
  .map(({ path, sha, size }) => {
    if (size === undefined) throw new Error(`Missing size for ${path}.`)
    return { file: path, sha, size }
  }).sort((a, b) => a.file.localeCompare(b.file))
if (!files.length) throw new Error('The datasets tree contains no IDF files.')
writeFileSync(new URL('../src/mcp/dataset-index.json', import.meta.url), `${JSON.stringify({ version, commit, files })}\n`)
console.log(`Indexed ${files.length} EnergyPlus ${version} DataSets at commit ${commit}.`)
