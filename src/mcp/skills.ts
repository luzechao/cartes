export const skills = {
  'diagnose-simulation-errors': {
    description: 'Investigate EnergyPlus failures and verify an evidence-based correction.',
    steps: [
      'Check run_simulation completion, exit code and severe/fatal messages. Read eplusout.err with run_python if more detail is needed.',
      'Start with the first severe error, not the final fatal announcement. Use inspect, find_objects, inspect_hvac_topology and the reference tools to connect the message to actual model fields and nodes.',
      'Explain the evidence and propose one correction. Apply only through model tools and respect user approval.',
      'Validate, then rerun with the user’s agreement. A design-day-only run may require changing simulation settings or weather selection; do not change either silently. Report remaining errors and warnings.',
    ],
  },
  'learn-from-examples': {
    description: 'Find an example object and adapt it to the open model.',
    steps: [
      'Search example_library by class or filename. Its catalog matches the bundled EnergyPlus engine; non-bundled models are fetched individually from GitHub.',
      'Inspect a matching object and its direct dependencies. Follow further references as needed; direct dependencies are not necessarily a complete reusable template.',
      'Use describe_class and reference tools to check the open model’s schema version, required fields and compatibility.',
      'Explain proposed adaptations, add objects through the model tools with approval, and validate the model.',
    ],
  },
} as const

const errorGuidance: Array<{ matches: RegExp; suggestions: string[] }> = [
  {
    matches: /\bnode\b/i,
    suggestions: [
      'Find the named node and its users; inspect the loop’s declared branches and connectors where applicable.',
      'Compare the reported inlet and outlet fields and check spelling and referenced NodeLists; declared connections are not proof of valid flow.',
    ],
  },
  {
    matches: /\b(schedule|setpoint|thermostat)\b/i,
    suggestions: [
      'Inspect the named schedule or thermostat, its references and type limits; check the reported values and required schedule type.',
      'For dual setpoints, check that heating and cooling schedules do not conflict at the affected times.',
    ],
  },
  {
    matches: /\b(surface|construction|material)\b/i,
    suggestions: [
      'Inspect the named surface, construction or material and follow the relevant references and required fields.',
      'For geometry messages, check surface vertices and boundary relationships before changing the model.',
    ],
  },
  {
    matches: /\b(not found|does not exist|missing|invalid reference)\b/i,
    suggestions: [
      'Check the exact object name and class against the reported field, including spelling and required references.',
    ],
  },
]

/** Extract severe/fatal records and attach tentative, offline investigation prompts. */
export function diagnoseEnergyPlusErrors(text: string) {
  const records: Array<{ severity: 'severe' | 'fatal'; message: string }> = []
  let current: { severity: 'severe' | 'fatal'; message: string } | undefined
  for (const line of text.split(/\r?\n/)) {
    const start = /^\s*\*\*\s*(severe|fatal)\s*\*\*\s*(.*)$/i.exec(line)
    if (start) {
      current = { severity: start[1]!.toLowerCase() === 'severe' ? 'severe' : 'fatal', message: start[2]!.trim() }
      records.push(current)
    } else {
      const continuation = /^\s*\*\*\s*~~~\s*\*\*\s*(.*)$/.exec(line)
      if (continuation && current) current.message += `\n${continuation[1]!.trim()}`
      else current = undefined
    }
  }
  return {
    total: records.length,
    truncated: records.length > 20,
    records: records.slice(0, 20).map((record) => ({
      severity: record.severity,
      message: record.message.slice(0, 3000),
      messageTruncated: record.message.length > 3000,
      suggestions: errorGuidance.filter((item) => item.matches.test(record.message)).flatMap((item) => item.suggestions),
    })),
    note: 'Suggestions are tentative investigation prompts, not diagnoses or fixes. Start with the first severe error, inspect the model and full log, then validate and rerun after an approved change.',
  }
}
