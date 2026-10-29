import type { Category, Severity } from "../repo-config.js"

/** What the model is asked to return for each issue (validated before use; models can be wrong). */
export type ModelFinding = {
  path: string
  line: number
  severity: Severity
  category: Category
  title: string
  explanation: string
  suggestion?: string
  confidence: number
}

export type ReviewRequest = { system: string; prompt: string }
export type ReviewResponse = { findings: unknown[]; inputTokens: number; outputTokens: number; model: string }

export interface LlmProvider {
  readonly name: string
  readonly model: string
  review(req: ReviewRequest): Promise<ReviewResponse>
}

export class LlmError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message)
    this.name = "LlmError"
  }
}
