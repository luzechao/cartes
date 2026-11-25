import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { expect, it } from 'vitest'
import { defaultSettings } from '../../src/agent/settings.js'
import { AgentPanel } from '../../src/ui/AgentPanel.js'
import type { Agent } from '../../src/ui/useAgent.js'

it('renders accessible scenario bars and a time-series line with negative values', () => {
  const agent: Agent = {
    settings: defaultSettings(), updateSettings() {}, problem: undefined, running: false, approvals: {},
    send() {}, stop() {}, newChat() {}, decide() {},
    items: [{ id: 1, role: 'assistant', parts: [
      { type: 'tool', id: 'a', name: 'run_scenarios', state: 'done', input: {}, output: {
        charts: [{ kind: 'bar', title: 'Site energy', units: 'kWh', points: [{ label: 'Baseline', value: 10 }, { label: 'Efficient', value: 8 }] }],
      } },
      { type: 'tool', id: 'b', name: 'plot_timeseries', state: 'done', input: {}, output: {
        charts: [{ kind: 'line', title: 'Outdoor temperature', units: 'C', points: [{ label: '01-01', value: -5 }, { label: '01-02', value: 3 }] }],
      } },
    ] }],
  }
  const html = renderToStaticMarkup(createElement(AgentPanel, { agent, hasModel: true }))
  expect(html).toContain('<meter')
  expect(html).toContain('Baseline: 10 kWh')
  expect(html).toContain('<polyline')
  expect(html).toContain('from -5 to 3 C')
  expect(html).toContain('Points are equally spaced')
  expect(html).toContain('Data and details')
})
