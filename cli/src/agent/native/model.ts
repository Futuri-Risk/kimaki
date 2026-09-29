import { fail, text, integer } from './errors.js'
import type { ModelSelection } from './types.js'
export type NativeModel = {
  modelId: string
  label: string
  contextWindow: number
  maxOutputTokens: number
  reasoning?: {
    enabled: boolean
    levels: readonly {
      value: string
      label: string
    }[]
    defaultLevel: string
  }
}
export type NativeProvider = {
  providerId: string
  kind: string
  apiFormat: 'anthropic-messages' | 'openai-chat-completions'
  baseURL: string
  models: readonly NativeModel[]
  authentication: 'native' | 'api-key'
}
export function runtimeModel(provider: NativeProvider, selection: ModelSelection, secret?: string) {
  if (provider.providerId !== selection.providerId) {
    throw fail('MODEL_UNAVAILABLE', 'Selected provider does not match.')
  }
  const model = provider.models.find((m) => m.modelId === selection.modelId)
  if (!model) {
    throw fail('MODEL_UNAVAILABLE', 'Selected model is absent from the native catalog.')
  }
  integer(model.contextWindow)
  integer(model.maxOutputTokens)
  if (
    selection.reasoning &&
    !model.reasoning?.levels.some((l) => l.value === selection.reasoning)
  ) {
    throw fail('THOUGHT_LEVEL_UNSUPPORTED', 'Requested native reasoning level is not advertised.')
  }
  const url = new URL(provider.baseURL)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw fail(
      'ENDPOINT_UNAPPROVED',
      'Custom provider endpoints must use approved HTTPS without URL credentials.',
    )
  }
  if (provider.authentication === 'api-key' && !secret) {
    throw fail('AUTH_REQUIRED', 'Selected API profile requires its explicit credential.')
  }
  if (provider.authentication === 'native' && secret) {
    throw fail('CONFIG_INVALID', 'Native authentication must not be replaced by an inline key.')
  }
  return {
    revision: text(selection.revision),
    generatedAt: Date.now(),
    model: { providerId: selection.providerId, modelId: selection.modelId },
    provider: {
      providerId: provider.providerId,
      kind: provider.kind,
      apiFormat: provider.apiFormat,
      baseURL: provider.baseURL,
      models: [model],
      ...(secret ? { apiKey: { source: 'inline', value: secret } } : {}),
    },
  }
}
