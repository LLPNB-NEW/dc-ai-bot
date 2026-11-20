import type { LlmProvider, ProviderId } from '../types';
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiCompatProvider } from './openai-compat';

export { createAnthropicProvider } from './anthropic';
export { createGeminiProvider } from './gemini';
export { createOpenAiCompatProvider } from './openai-compat';

export function createProviders(): Record<ProviderId, LlmProvider> {
  return {
    'openai-compat': createOpenAiCompatProvider(),
    anthropic: createAnthropicProvider(),
    gemini: createGeminiProvider(),
  };
}
