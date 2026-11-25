import { expect, it } from 'vitest'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { ModelSession } from '../../src/mcp/session.js'
import { readManualSection } from '../../src/mcp/manual.js'

setSchemaBundle(localBundle())

it('searches and retrieves full IDD field notes with explicit source and paging', async () => {
  const s = new ModelSession()
  s.openText('Version, 26.1;')
  await s.prepare({ prose: true })
  const hits = s.searchReference('cooling cop', 1)
  expect(hits.source).toContain('not full manuals')
  expect(hits.total).toBeGreaterThan(1)
  expect(hits.results).toHaveLength(1)
  expect(s.searchReference('cooling cop', 1, 1).results).not.toEqual(hits.results)
  const field = s.fieldReference('Coil:Cooling:DX:SingleSpeed', 'Gross Rated Cooling COP')
  expect(field.field).toMatchObject({ name: 'gross_rated_cooling_cop', units: 'W/W' })
  expect(field.manualUrl).toContain('/io-reference/')
  expect(() => s.fieldReference('Coil:Cooling:DX:SingleSpeed', 'unknown')).toThrow(/No field/)
})

it('extracts and pages one manual section without including the next one', async () => {
  const page = '<h2 id="one">One<a class="headerlink">¶</a></h2><p>First &amp; second.</p><h3>Field</h3><p>Details.</p><h2 id="two">Two</h2><p>Other.</p>'
  const fetchPage: typeof fetch = async () => new Response(page, { status: 200 })
  const url = 'https://docs.idfkit.com/v26.1/io-reference/group/#one'
  const first = await readManualSection(url, { limit: 12 }, fetchPage)
  expect(first.nextOffset).toBe(12)
  const rest = await readManualSection(url, { offset: 12, limit: 100 }, fetchPage)
  expect(first.text + rest.text).toContain('First & second.')
  expect(first.text + rest.text).toContain('Details.')
  expect(first.text + rest.text).not.toContain('Other.')
  await expect(readManualSection('https://example.com/#one', {}, fetchPage)).rejects.toThrow(/Unsupported/)
  await expect(readManualSection('https://docs.idfkit.com/#missing', {}, fetchPage)).rejects.toThrow(/not found/)
})
