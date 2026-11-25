import { Parser } from 'htmlparser2'
import { z } from 'zod'

export const manualInput = {
  class: z.string().describe('EnergyPlus object class.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(12000).optional(),
}

/** Read one object section from a versioned, schema-derived documentation URL. */
export async function readManualSection(
  manualUrl: string,
  options: { offset?: number | undefined; limit?: number | undefined } = {},
  fetchPage: typeof fetch = fetch,
) {
  const url = new URL(manualUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'docs.idfkit.com' || !url.hash) {
    throw new Error('Unsupported documentation URL.')
  }
  const anchor = decodeURIComponent(url.hash.slice(1))
  url.hash = ''
  const response = await fetchPage(url, { credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error(`Reference documentation returned HTTP ${response.status}.`)
  const length = Number(response.headers.get('content-length'))
  if (length > 10_000_000) throw new Error('Reference documentation page exceeds the size limit.')
  const html = await response.text()
  if (html.length > 10_000_000) throw new Error('Reference documentation page exceeds the size limit.')
  let active = false
  let found = false
  let done = false
  let headingLevel = 0
  let hidden = 0
  let text = ''
  const block = new Set(['p', 'div', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const parser = new Parser({
    onopentag(name, attrs) {
      const heading = /^h([1-6])$/.exec(name)
      if (heading && active && Number(heading[1]) <= headingLevel) {
        active = false
        done = true
      }
      if (!done && !found && heading && attrs.id === anchor) {
        found = true
        active = true
        headingLevel = Number(heading[1])
      }
      if (!active) return
      if (hidden) hidden++
      else if (name === 'script' || name === 'style' || (name === 'a' && attrs.class?.split(/\s+/).includes('headerlink'))) hidden = 1
      else if (block.has(name)) text += '\n'
    },
    ontext(value) {
      if (active && !hidden) text += value
    },
    onclosetag(name) {
      if (!active) return
      if (hidden) hidden--
      else if (block.has(name)) text += '\n'
    },
  }, { decodeEntities: true })
  parser.end(html)
  if (!found) throw new Error(`Reference section '${anchor}' was not found.`)
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const offset = options.offset ?? 0
  const limit = options.limit ?? 6000
  return {
    source: manualUrl,
    text: text.slice(offset, offset + limit),
    offset,
    totalCharacters: text.length,
    nextOffset: offset + limit < text.length ? offset + limit : null,
    note: 'Online I/O Reference; tables and equations are rendered as plain text.',
  }
}
