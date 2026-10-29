/**
 * Review local changes without GitHub — the same engine, printed to the terminal.
 *
 *   npm run review:local                    # working tree vs HEAD
 *   npm run review:local -- --base main     # this branch vs main
 *   ANTHROPIC_API_KEY=… npm run review:local -- --base main
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { parseArgs } from "node:util"
import { analyze, select, type InputFile } from "../review/analyze.js"
import { AnthropicProvider } from "../review/llm/anthropic.js"
import { parseRepoConfig } from "../review/repo-config.js"

const { values } = parseArgs({ options: { base: { type: "string" }, "all-severities": { type: "boolean", default: false } } })

const diff = execFileSync("git", ["diff", "--unified=3", "--no-color", "--no-ext-diff", ...(values.base ? [`${values.base}...HEAD`] : ["HEAD"])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

/** Splits `git diff` output into GitHub-style per-file patches. */
export function splitGitDiff(text: string): InputFile[] {
  const files: InputFile[] = []
  for (const block of text.split(/^diff --git /m).slice(1)) {
    const lines = block.split("\n")
    const path = lines.find((l) => l.startsWith("+++ "))?.replace(/^\+\+\+ (b\/)?/, "")
    const deleted = lines.some((l) => l.startsWith("deleted file mode"))
    const start = lines.findIndex((l) => l.startsWith("@@"))
    if (!path || path === "/dev/null") continue
    files.push({ path, status: deleted ? "removed" : lines.some((l) => l.startsWith("new file mode")) ? "added" : "modified", patch: start >= 0 ? lines.slice(start).join("\n") : null })
  }
  return files
}

const cfgText = existsSync(".diffwise.yml") ? readFileSync(".diffwise.yml", "utf8") : null
const { config, error } = parseRepoConfig(values["all-severities"] ? `${cfgText ?? ""}\nmin_severity: low` : cfgText)
if (error) console.warn(`⚠ ${error}`)

const key = process.env.ANTHROPIC_API_KEY
const provider = key
  ? new AnthropicProvider({ apiKey: key, model: process.env.LLM_MODEL ?? "claude-sonnet-5-5", baseUrl: process.env.LLM_BASE_URL ?? "https://api.anthropic.com", maxOutputTokens: 4096, timeoutMs: 120_000 })
  : null

const files = splitGitDiff(diff)
if (!files.length) {
  console.log("No changes to review.")
  process.exit(0)
}
const a = await analyze(files, config, { provider, prTitle: values.base ? `Changes since ${values.base}` : "Working tree changes" })
const reported = select(a.findings, new Set(), 1000)

const colour = { critical: "\x1b[31m", high: "\x1b[31m", medium: "\x1b[33m", low: "\x1b[90m" } as const
console.log(`\nReviewed ${a.reviewedFiles.length} files (${a.linesReviewed} added lines) with ${provider ? `rules + ${provider.model}` : "built-in rules only (set ANTHROPIC_API_KEY for AI review)"}\n`)
for (const f of reported) {
  console.log(`${colour[f.severity]}${f.severity.toUpperCase()}\x1b[0m ${f.path}:${f.line} · ${f.category} · ${f.title}`)
  console.log(`  ${f.body}`)
  if (f.suggestion !== null) console.log(`  suggestion: ${f.suggestion || "(delete this line)"}`)
  console.log()
}
for (const n of a.notes) console.log(`note: ${n}`)
console.log(reported.length ? `${reported.length} issue${reported.length === 1 ? "" : "s"} found.` : "No issues found.")
process.exit(reported.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0)
