import { CATEGORIES, SEVERITIES } from "../repo-config.js"
import { LlmError, type LlmProvider, type ReviewRequest, type ReviewResponse } from "./provider.js"

/**
 * Forcing a tool call gives us structured JSON validated against this schema, instead of parsing
 * prose. The model is instructed to call it once with every finding (possibly none).
 */
export const REPORT_TOOL = {
  name: "report_findings",
  description: "Report the review findings for the diff. Call exactly once. Use an empty list when nothing meets the bar.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path exactly as shown in the <file path=...> tag" },
            line: { type: "integer", description: "A line number from a line marked '+' in that file" },
            severity: { type: "string", enum: [...SEVERITIES] },
            category: { type: "string", enum: [...CATEGORIES] },
            title: { type: "string", description: "One short sentence naming the problem (max ~80 chars)" },
            explanation: { type: "string", description: "Why it is wrong and its concrete impact, 1–3 sentences" },
            suggestion: { type: "string", description: "Optional: replacement text for exactly that one line. Omit if a fix needs more than one line." },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["path", "line", "severity", "category", "title", "explanation", "confidence"],
        },
      },
    },
    required: ["findings"],
  },
} as const

type MessagesResponse = {
  model: string
  stop_reason: string
  content: ({ type: "tool_use"; name: string; input: { findings?: unknown[] } } | { type: "text"; text: string })[]
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic"

  constructor(
    private opts: { apiKey: string; model: string; baseUrl: string; maxOutputTokens: number; timeoutMs: number; maxRetries?: number },
  ) {}

  get model() {
    return this.opts.model
  }

  async review(req: ReviewRequest): Promise<ReviewResponse> {
    const retries = this.opts.maxRetries ?? 3
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call(req)
      } catch (err) {
        const retryable = err instanceof LlmError && err.retryable
        if (!retryable || attempt >= retries) throw err
        await new Promise((r) => setTimeout(r, Math.min(20_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)))
      }
    }
  }

  private async call(req: ReviewRequest): Promise<ReviewResponse> {
    let res: Response
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: this.opts.maxOutputTokens,
          temperature: 0,
          system: req.system,
          tools: [REPORT_TOOL],
          tool_choice: { type: "tool", name: REPORT_TOOL.name },
          messages: [{ role: "user", content: req.prompt }],
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      throw new LlmError(`Could not reach the model API: ${(err as Error).message}`, true)
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300)
      // 429 rate limit, 529 overloaded, 5xx: try again later. 4xx: our request is wrong.
      throw new LlmError(`Model API returned ${res.status}: ${text}`, res.status === 429 || res.status >= 500)
    }
    const data = (await res.json()) as MessagesResponse
    const tool = data.content.find((c) => c.type === "tool_use" && c.name === REPORT_TOOL.name) as { input: { findings?: unknown[] } } | undefined
    if (!tool) throw new LlmError(`Model did not return findings (stop_reason: ${data.stop_reason})`, data.stop_reason === "max_tokens")
    return {
      findings: Array.isArray(tool.input.findings) ? tool.input.findings : [],
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model ?? this.opts.model,
    }
  }
}
