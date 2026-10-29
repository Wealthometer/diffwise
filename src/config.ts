import { z } from "zod"

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"))

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  COOKIE_SECURE: bool(false),

  // GitHub App (create one from app-manifest.json, see README)
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1).transform((k) => k.replace(/\\n/g, "\n")),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  /** The app's URL slug, for the "Install" link (github.com/apps/<slug>). */
  GITHUB_APP_SLUG: z.string().default("diffwise"),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
  /** The bot's slash command, e.g. "/diffwise review" in a PR comment. */
  BOT_COMMAND: z.string().default("/diffwise"),

  // LLM. Without a key, Diffwise runs its deterministic rules only.
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  LLM_MODEL: z.string().default("claude-sonnet-5-5"),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).default(4096),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  /** In-call retries for overloads/rate limits, before the job-level retry kicks in. */
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  /** USD per million tokens, only used for the cost estimate shown in the dashboard. */
  LLM_INPUT_PRICE_PER_MTOK: z.coerce.number().min(0).default(3),
  LLM_OUTPUT_PRICE_PER_MTOK: z.coerce.number().min(0).default(15),

  // Limits
  MAX_PR_CHANGED_LINES: z.coerce.number().int().min(1).default(3000),
  MAX_PROMPT_CHARS_PER_BATCH: z.coerce.number().int().min(2000).default(60_000),
  DEFAULT_MONTHLY_REVIEW_LIMIT: z.coerce.number().int().min(0).default(300),
  DEFAULT_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(5_000_000),
  /** Wait this long after a push before reviewing, so rapid pushes produce one review. */
  REVIEW_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).default(20),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  JOB_LOCK_SECONDS: z.coerce.number().int().min(30).default(300),
})

export type Config = z.infer<typeof schema>

let cached: Config | undefined
export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
      throw new Error(`Invalid configuration:\n${issues}`)
    }
    cached = parsed.data
  }
  return cached
}

export function resetConfig() {
  cached = undefined
}
