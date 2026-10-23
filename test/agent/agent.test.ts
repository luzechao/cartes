import { describe, expect, it, vi } from 'vitest'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel, EditHistory, LATEST_IDD_VERSION, newModelSource } from '../../src/model/index.js'
import type { AttachedDocument } from '../../src/mcp/session.js'
import { createAgentTools, limitOutput, needsApproval, type AgentHost } from '../../src/agent/tools.js'
import { runAgentTurn, type AgentEvent } from '../../src/agent/loop.js'
import { buildInstructions } from '../../src/agent/prompt.js'
import { defaultSettings, settingsProblem } from '../../src/agent/settings.js'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'

setSchemaBundle(localBundle())

/** A stand-in for App: one open document, rebuilt after every edit as App's commit does. */
function fakeApp(opts: { editMode?: 'ask' | 'auto'; approve?: boolean } = {}) {
  const text = newModelSource(LATEST_IDD_VERSION)
  const doc = parseIdf(text)
  const open: AttachedDocument = { name: 'test.idf', original: text, doc, model: buildModel(doc), history: new EditHistory(doc) }
  const approvals: string[] = []
  const host: AgentHost = {
    document: () => open,
    afterEdit: vi.fn(() => {
      open.model = buildModel(open.doc)
    }),
    editMode: () => opts.editMode ?? 'ask',
    approve: async (request) => {
      approvals.push(request.toolName)
      return opts.approve ?? true
    },
    runPython: async (code) => ({ ok: true, value: `ran ${code.length} chars`, stdout: '', stderr: '' }),
    runSimulation: async () => ({ exitCode: 0 }),
    queryResults: async () => {
      throw new Error('no results')
    },
    outputText: () => undefined,
    useWeather: async () => {
      throw new Error('no weather')
    },
    lastDesignConditions: () => undefined,
  }
  return { open, host, approvals }
}

const SQUARE = { name: 'Office', footprint: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 3 }

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

/** A mock model that answers each call with the next script. */
function scripted(...scripts: Array<Array<Record<string, unknown>>>): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = scripts[Math.min(call++, scripts.length - 1)]!
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) }
    },
  })
}

function toolCall(id: string, name: string, input: unknown) {
  return [
    { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  ]
}

function reply(text: string) {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  ]
}

const exec = (tools: ReturnType<typeof createAgentTools>, name: string, input: unknown, id = 'c1') =>
  tools[name]!.execute!(input as never, { toolCallId: id, messages: [] } as never)

describe('agent tools', () => {
  it('offers the model tools, Python and simulation — not opening, saving or replacing the file', () => {
    const tools = createAgentTools(fakeApp().host)
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['summary', 'list_objects', 'set_field', 'run_python', 'run_simulation']))
    for (const name of ['open_idf', 'save_idf', 'new_model']) expect(tools[name]).toBeUndefined()
  })

  it('reads without asking', async () => {
    const app = fakeApp()
    const out = (await exec(createAgentTools(app.host), 'list_objects', {})) as { classes: Array<{ class: string }> }
    expect(out.classes.map((c) => c.class)).toContain('Construction')
    expect(app.approvals).toEqual([])
  })

  it('asks before an edit, and a refusal changes nothing', async () => {
    const app = fakeApp({ approve: false })
    const out = await exec(createAgentTools(app.host), 'extrude_zone', SQUARE)
    expect(out).toMatchObject({ rejected: true })
    expect(app.approvals).toEqual(['extrude_zone'])
    expect(app.open.model.zones.size).toBe(0)
    expect(app.open.history.canUndo).toBe(false)
  })

  it('applies an approved edit to the app’s document as one undo step', async () => {
    const app = fakeApp()
    const out = (await exec(createAgentTools(app.host), 'extrude_zone', SQUARE)) as { surfaces: string[] }
    expect(out.surfaces).toHaveLength(6)
    expect(app.host.afterEdit).toHaveBeenCalled()
    expect(app.open.model.zones.size).toBe(1)
    expect(app.open.history.undoLabel).toBe('Agent: extrude zone')
    app.open.history.undo()
    expect(buildModel(app.open.doc).zones.size).toBe(0)
  })

  it('does not ask in automatic mode', async () => {
    const app = fakeApp({ editMode: 'auto' })
    await exec(createAgentTools(app.host), 'extrude_zone', SQUARE)
    expect(app.approvals).toEqual([])
    expect(app.open.model.zones.size).toBe(1)
  })

  it('returns session refusals as results the model can act on', async () => {
    const app = fakeApp()
    const out = await exec(createAgentTools(app.host), 'set_field', { object: 'Nowhere', field: 'Name', value: 'x' })
    expect(out).toEqual({ error: "No object named 'Nowhere'." })
  })

  it('addresses an unnamed singleton by its class', async () => {
    const app = fakeApp({ editMode: 'auto' })
    const tools = createAgentTools(app.host)
    await exec(tools, 'set_field', { object: 'Timestep', field: 0, value: '6' })
    const out = (await exec(tools, 'inspect', { name: 'timestep' })) as { fields: Array<{ value: string }> }
    expect(out.fields[0]!.value).toBe('6')
  })

  it('undoes through the app’s history', async () => {
    const app = fakeApp({ editMode: 'auto' })
    const tools = createAgentTools(app.host)
    await exec(tools, 'extrude_zone', SQUARE)
    expect(await exec(tools, 'undo', {})).toEqual({ undid: 'Agent: extrude zone' })
    expect(app.open.model.zones.size).toBe(0)
  })

  it('cuts long output', () => {
    const out = limitOutput({ big: 'x'.repeat(100) }, 50) as { truncated: boolean; text: string }
    expect(out.truncated).toBe(true)
    expect(out.text).toHaveLength(50)
    expect(needsApproval('summary')).toBe(false)
    expect(needsApproval('delete_surface')).toBe(true)
  })
})

describe('agent turn', () => {
  it('calls a tool, feeds back the result and answers', async () => {
    const app = fakeApp()
    const events: AgentEvent[] = []
    const model = scripted(toolCall('c1', 'extrude_zone', SQUARE), reply('Added zone Office.'))
    const user: ModelMessage = { role: 'user', content: 'Add a 6 by 4 m office' }
    const r = await runAgentTurn({
      model,
      instructions: buildInstructions({ modelName: 'test.idf', editMode: 'ask' }),
      messages: [user],
      tools: createAgentTools(app.host),
      onEvent: (e) => events.push(e),
    })
    expect(r.error).toBeUndefined()
    expect(events.map((e) => e.type)).toEqual(['tool-call', 'tool-result', 'text'])
    expect(events[2]).toEqual({ type: 'text', text: 'Added zone Office.' })
    expect(app.open.model.zones.size).toBe(1)
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('reports a provider error instead of throwing', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('401 Unauthorized')
      },
    })
    const r = await runAgentTurn({
      model,
      instructions: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      onEvent: () => {},
    })
    expect(r.error).toContain('401')
  })
})

describe('agent settings', () => {
  it('needs a key for hosted providers but not for a local server', () => {
    const s = defaultSettings()
    expect(s.editMode).toBe('ask')
    expect(settingsProblem(s)).toMatch(/API key/)
    s.provider = 'openai-compatible'
    s.models['openai-compatible'] = 'llama3.2'
    expect(settingsProblem(s)).toBeUndefined()
  })
})
