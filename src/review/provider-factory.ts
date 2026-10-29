import { config } from "../config.js"
import { AnthropicProvider } from "./llm/anthropic.js"
import type { LlmProvider } from "./llm/provider.js"

/** Returns the configured model provider, or null to run the built-in checks only. */
export function defaultProvider(): LlmProvider | null {
  const cfg = config()
  if (!cfg.ANTHROPIC_API_KEY) return null
  return new AnthropicProvider({
    apiKey: cfg.ANTHROPIC_API_KEY,
    model: cfg.LLM_MODEL,
    baseUrl: cfg.LLM_BASE_URL,
    maxOutputTokens: cfg.LLM_MAX_OUTPUT_TOKENS,
    timeoutMs: cfg.LLM_TIMEOUT_MS,
    maxRetries: cfg.LLM_MAX_RETRIES,
  })
}
