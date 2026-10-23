/**
 * Language-model providers for the agent, called straight from the browser with the user's own
 * key — there is no cartes server in between.
 */
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AgentSettings } from './settings.js'

export function createLanguageModel(s: AgentSettings): LanguageModel {
  const modelId = s.models[s.provider].trim()
  const apiKey = s.apiKeys[s.provider].trim()
  switch (s.provider) {
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
    case 'anthropic':
      return createAnthropic({
        apiKey,
        // Anthropic refuses browser requests without this opt-in; the key is the user's own.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      })(modelId)
    case 'openai-compatible':
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: s.baseURL.trim().replace(/\/+$/, ''),
        ...(apiKey ? { apiKey } : {}),
        includeUsage: true,
      }).chatModel(modelId)
  }
}
