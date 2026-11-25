import { afterEach, expect, it, vi } from 'vitest'
import { ENERGYPLUS_VERSION } from '@luzechao/sim-engine-wasm'
import { localBundle } from '@idfkit/schemas/node'
import { buildModel, EditHistory, LATEST_IDD_VERSION, newModelSource } from '../../src/model/index.js'
import { parseIdf } from '../../src/parser/index.js'
import type { AttachedDocument } from '../../src/mcp/session.js'
import { setSchemaBundle } from '../../src/schema/index.js'

vi.mock('../../src/mcp/datasets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/datasets.js')>()
  return { ...actual, planDatasetImport: vi.fn() }
})

import { planDatasetImport, type DatasetImportPlan } from '../../src/mcp/datasets.js'
import { createAgentTools, type AgentHost } from '../../src/agent/tools.js'

setSchemaBundle(localBundle())
afterEach(() => vi.clearAllMocks())

function fakeApp(approved: boolean) {
  const text = newModelSource(LATEST_IDD_VERSION)
  const doc = parseIdf(text)
  const open: AttachedDocument = {
    name: 'test.idf', original: text, doc, model: buildModel(doc), history: new EditHistory(doc),
  }
  const host: AgentHost = {
    document: () => open,
    afterEdit: vi.fn(() => { open.model = buildModel(open.doc) }),
    editMode: () => 'ask',
    approve: vi.fn(async () => approved),
    runPython: async () => ({ ok: true, stdout: '', stderr: '' }),
    runSimulation: async () => ({}),
    runScenarios: async () => ({ weather: 'none' }),
    readTimeseries: async () => [],
    queryResults: async () => ({ columns: [], rows: [] }),
    outputText: () => undefined,
    useWeather: async () => ({ station: {} as never, designDays: [] }),
    lastDesignConditions: () => undefined,
  }
  return { open, host }
}

function plan(): DatasetImportPlan {
  const values = ['Imported Material', 'Rough', '0.1', '0.9', '1000', '800', '0.9', '0.7', '0.7']
  return {
    scope: `EnergyPlus ${ENERGYPLUS_VERSION}`,
    file: 'Boilers.idf',
    version: ENERGYPLUS_VERSION,
    root: { class: 'Material', name: 'Imported Material' },
    objects: [{
      class: 'Material', name: values[0]!,
      fields: values.map((value, index) => ({ index, name: `Field ${index + 1}`, value })),
    }],
    references: [],
    truncated: false,
    remaining: 0,
    note: '',
    diagnostics: [],
    diagnosticsTruncated: false,
  }
}

const executeImport = (host: AgentHost) =>
  createAgentTools(host).import_dataset!.execute!(
    { dataset: 'Boilers.idf', class: 'Material', name: 'Imported Material' } as never,
    { toolCallId: 'import-call', messages: [] } as never,
  )

it('requests approval before importing and records one agent undo step', async () => {
  vi.mocked(planDatasetImport).mockResolvedValue(plan())
  const app = fakeApp(true)
  const result = await executeImport(app.host)
  expect(app.host.approve).toHaveBeenCalledWith(expect.objectContaining({
    toolName: 'import_dataset', kind: 'edit',
  }), undefined)
  expect(result).toMatchObject({ imported: ["Material 'Imported Material'"], count: 1 })
  expect(app.open.history.undoLabel).toBe('Agent: import dataset')
  expect(app.host.afterEdit).toHaveBeenCalledOnce()
})

it('does not edit or refresh the model when approval is declined', async () => {
  vi.mocked(planDatasetImport).mockResolvedValue(plan())
  const app = fakeApp(false)
  const result = await executeImport(app.host)
  expect(result).toMatchObject({ rejected: true })
  const materials = (app.open.doc.byClass.get('material') ?? [])
    .map((id) => app.open.doc.objects.get(id)?.fields[0]?.value)
  expect(materials).not.toContain('Imported Material')
  expect(app.open.history.undoLabel).toBeUndefined()
  expect(app.host.afterEdit).not.toHaveBeenCalled()
})
