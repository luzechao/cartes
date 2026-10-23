/**
 * Agent settings: provider, model, keys and edit mode. Settings live in localStorage; keys live
 * in sessionStorage (gone when the tab closes) unless the user asks to remember them.
 *
 * No AI SDK import here, so the settings UI loads without it; `providers.ts` creates the models.
 */

export type ProviderId = 'openai' | 'anthropic' | 'openai-compatible'

export type EditMode = 'ask' | 'auto'

export interface ProviderInfo {
  label: string
  defaultModel: string
  /** Offered in the model field; any other id can be typed. */
  suggestions: string[]
  needsBaseURL: boolean
  keyRequired: boolean
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.6',
    suggestions: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6', 'gpt-5.6-luna', 'gpt-4.1'],
    needsBaseURL: false,
    keyRequired: true,
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-5-5',
    suggestions: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
    needsBaseURL: false,
    keyRequired: true,
  },
  'openai-compatible': {
    label: 'OpenAI-compatible',
    defaultModel: '',
    suggestions: [],
    needsBaseURL: true,
    // Local servers (Ollama, LM Studio) take no key.
    keyRequired: false,
  },
}

export interface AgentSettings {
  provider: ProviderId
  /** Model id per provider, so switching back keeps what was typed. */
  models: Record<ProviderId, string>
  baseURL: string
  apiKeys: Record<ProviderId, string>
  /** Keep keys in localStorage across sessions instead of sessionStorage. */
  rememberKeys: boolean
  editMode: EditMode
}

export function defaultSettings(): AgentSettings {
  return {
    provider: 'openai',
    models: { openai: PROVIDERS.openai.defaultModel, anthropic: PROVIDERS.anthropic.defaultModel, 'openai-compatible': '' },
    baseURL: 'http://localhost:11434/v1',
    apiKeys: { openai: '', anthropic: '', 'openai-compatible': '' },
    rememberKeys: false,
    editMode: 'ask',
  }
}

/** Why the settings cannot be used yet, or undefined if they can. */
export function settingsProblem(s: AgentSettings): string | undefined {
  const info = PROVIDERS[s.provider]
  if (!s.models[s.provider].trim()) return 'Choose a model in the Agent tab.'
  if (info.needsBaseURL && !s.baseURL.trim()) return 'Enter the base URL of the OpenAI-compatible server.'
  if (info.keyRequired && !s.apiKeys[s.provider].trim()) return `Enter your ${info.label} API key in the Agent tab.`
  return undefined
}

const SETTINGS_KEY = 'cartes.agent.settings'
const KEYS_KEY = 'cartes.agent.keys'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storages(): { local: StorageLike | undefined; session: StorageLike | undefined } {
  try {
    return { local: globalThis.localStorage, session: globalThis.sessionStorage }
  } catch {
    return { local: undefined, session: undefined }
  }
}

function readJson(store: StorageLike | undefined, key: string): unknown {
  try {
    const text = store?.getItem(key)
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

export function loadSettings(): AgentSettings {
  const { local, session } = storages()
  const base = defaultSettings()
  const saved = readJson(local, SETTINGS_KEY) as Partial<AgentSettings> | undefined
  const s: AgentSettings = {
    ...base,
    ...(saved ?? {}),
    models: { ...base.models, ...(saved?.models ?? {}) },
    apiKeys: { ...base.apiKeys },
  }
  if (!(s.provider in PROVIDERS)) s.provider = base.provider
  if (s.editMode !== 'ask' && s.editMode !== 'auto') s.editMode = base.editMode
  const keys = readJson(s.rememberKeys ? local : session, KEYS_KEY) as Partial<Record<ProviderId, string>> | undefined
  if (keys) for (const id of Object.keys(PROVIDERS) as ProviderId[]) if (typeof keys[id] === 'string') s.apiKeys[id] = keys[id]
  return s
}

export function saveSettings(s: AgentSettings): void {
  const { local, session } = storages()
  try {
    const { apiKeys, ...rest } = s
    local?.setItem(SETTINGS_KEY, JSON.stringify(rest))
    const keep = s.rememberKeys ? local : session
    const drop = s.rememberKeys ? session : local
    keep?.setItem(KEYS_KEY, JSON.stringify(apiKeys))
    drop?.removeItem(KEYS_KEY)
  } catch {
    // Storage full or blocked: settings simply do not persist.
  }
}
