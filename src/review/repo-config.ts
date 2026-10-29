import { parse as parseYaml } from "yaml"
import { z } from "zod"

export const CATEGORIES = ["bug", "security", "performance", "reliability", "maintainability", "style"] as const
export type Category = (typeof CATEGORIES)[number]
export const SEVERITIES = ["low", "medium", "high", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]
export const severityRank = (s: Severity) => SEVERITIES.indexOf(s)

export const RULE_IDS = [
  "hardcoded-secret",
  "private-key",
  "tls-verification-disabled",
  "sql-injection",
  "dynamic-code-execution",
  "unsafe-html",
  "weak-hash",
  "empty-catch",
  "debugger-statement",
  "console-log",
] as const
export type RuleId = (typeof RULE_IDS)[number]

const schema = z
  .object({
    enabled: z.boolean().default(true),
    review_drafts: z.boolean().default(false),
    /** Findings below this severity are not posted. */
    min_severity: z.enum(SEVERITIES).default("medium"),
    /** Model findings below this confidence are not posted (rules have fixed confidences). */
    min_confidence: z.number().min(0).max(1).default(0.7),
    max_comments: z.number().int().min(0).max(50).default(10),
    categories: z
      .object(Object.fromEntries(CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<Category, z.ZodOptional<z.ZodBoolean>>)
      .partial()
      .default({}),
    rules: z.object(Object.fromEntries(RULE_IDS.map((r) => [r, z.boolean().optional()])) as Record<RuleId, z.ZodOptional<z.ZodBoolean>>).partial().default({}),
    ignore: z.array(z.string().max(200)).max(100).default([]),
    /** Project-specific guidance passed to the model, e.g. "We use Result types, never throw". */
    instructions: z.string().max(2000).default(""),
  })
  .strict()

export type RepoConfig = z.infer<typeof schema> & { categoryEnabled: (c: Category) => boolean; ruleEnabled: (r: RuleId) => boolean }

const DEFAULT_CATEGORIES: Record<Category, boolean> = { bug: true, security: true, performance: true, reliability: true, maintainability: false, style: false }
const DEFAULT_RULES: Record<RuleId, boolean> = Object.fromEntries(RULE_IDS.map((r) => [r, r !== "console-log"])) as Record<RuleId, boolean>

function finish(c: z.infer<typeof schema>): RepoConfig {
  return {
    ...c,
    categoryEnabled: (cat) => c.categories[cat] ?? DEFAULT_CATEGORIES[cat],
    ruleEnabled: (r) => c.rules[r] ?? DEFAULT_RULES[r],
  }
}

export const DEFAULT_CONFIG: RepoConfig = finish(schema.parse({}))

/**
 * Parses .diffwise.yml. A broken file never blocks a review: we fall back to defaults and say why
 * in the review summary.
 */
export function parseRepoConfig(text: string | null): { config: RepoConfig; error: string | null } {
  if (!text?.trim()) return { config: DEFAULT_CONFIG, error: null }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { config: DEFAULT_CONFIG, error: `.diffwise.yml is not valid YAML (${(err as Error).message.split("\n")[0]}), so defaults were used.` }
  }
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return { config: DEFAULT_CONFIG, error: `.diffwise.yml: ${issue.path.join(".") || "file"}: ${issue.message}. Defaults were used.` }
  }
  return { config: finish(parsed.data), error: null }
}
