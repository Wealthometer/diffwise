import { createHash } from "node:crypto"
import { z } from "zod"
import { addedLines, countChanges, parsePatch, type Hunk } from "./diff.js"
import { languageOf, makeIgnoreMatcher, type FileSkip } from "./files.js"
import { LlmError, type LlmProvider } from "./llm/provider.js"
import { systemPrompt, userPrompt, renderFile, type PromptFile } from "./prompt.js"
import { CATEGORIES, SEVERITIES, severityRank, type Category, type RepoConfig, type Severity } from "./repo-config.js"
import { runRules } from "./rules.js"

export type InputFile = { path: string; status: string; patch?: string | null; previousPath?: string }

export type Outcome = "candidate" | "posted" | "summary" | "duplicate" | "below_threshold" | "disabled_category" | "unanchored" | "superseded_by_rule"

export type Finding = {
  path: string
  line: number | null
  severity: Severity
  category: Category
  title: string
  body: string
  suggestion: string | null
  confidence: number
  source: "rule" | "llm"
  ruleId: string | null
  fingerprint: string
  outcome: Outcome
}

export type Analysis = {
  findings: Finding[]
  reviewedFiles: string[]
  skippedFiles: FileSkip[]
  linesReviewed: number
  usage: { inputTokens: number; outputTokens: number; calls: number; model: string | null }
  mode: "full" | "rules_only"
  notes: string[]
  invalidModelFindings: number
}

const normalize = (s: string) => s.trim().replace(/\s+/g, " ")

/** Content-based, so the same issue keeps its identity when unrelated edits shift line numbers. */
export function fingerprint(path: string, category: string, anchor: string): string {
  return createHash("sha1").update(`${path}\u0000${category}\u0000${normalize(anchor)}`).digest("hex").slice(0, 20)
}

// Models are lenient JSON producers; accept reasonable shapes and normalise them.
const ModelFindingSchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  severity: z.string().transform((s) => s.toLowerCase()).pipe(z.enum(SEVERITIES)),
  category: z.string().transform((s) => s.toLowerCase()).pipe(z.enum(CATEGORIES)),
  title: z.string().min(1).transform((s) => s.trim().slice(0, 140)),
  explanation: z.string().min(1).transform((s) => s.trim().slice(0, 1200)),
  suggestion: z.string().optional().nullable(),
  confidence: z.coerce.number().transform((n) => Math.max(0, Math.min(1, n))),
})

type Prepared = { path: string; language: string; status: string; previousPath?: string; hunks: Hunk[]; added: Map<number, string> }

function prepare(files: InputFile[], cfg: RepoConfig) {
  const ignore = makeIgnoreMatcher(cfg.ignore)
  const prepared: Prepared[] = []
  const skipped: FileSkip[] = []
  for (const f of files) {
    const why = f.status === "removed" ? "deleted" : !f.patch ? "binary or too large for a diff" : ignore(f.path)
    if (why) {
      skipped.push({ path: f.path, reason: why })
      continue
    }
    const hunks = parsePatch(f.patch!)
    const added = addedLines(hunks)
    if (added.size === 0) {
      skipped.push({ path: f.path, reason: "no added lines" })
      continue
    }
    prepared.push({ path: f.path, language: languageOf(f.path), status: f.status, previousPath: f.previousPath, hunks, added })
  }
  return { prepared, skipped }
}

/** Packs files into prompts under a size budget; splits oversized files by hunk. */
export function batchFiles(files: Prepared[], maxChars: number): PromptFile[][] {
  const pieces: PromptFile[] = []
  for (const f of files) {
    const whole: PromptFile = { path: f.path, language: f.language, status: f.status, previousPath: f.previousPath, hunks: f.hunks }
    if (renderFile(whole).length <= maxChars) {
      pieces.push(whole)
      continue
    }
    let chunk: Hunk[] = []
    for (const h of f.hunks) {
      const candidate = { ...whole, hunks: [...chunk, h] }
      if (chunk.length && renderFile(candidate).length > maxChars) {
        pieces.push({ ...whole, hunks: chunk })
        chunk = [h]
      } else chunk.push(h)
    }
    if (chunk.length) pieces.push({ ...whole, hunks: chunk })
  }
  const batches: PromptFile[][] = []
  let cur: PromptFile[] = []
  let size = 0
  for (const p of pieces) {
    const len = renderFile(p).length
    if (cur.length && size + len > maxChars) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(p)
    size += len
  }
  if (cur.length) batches.push(cur)
  return batches
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx]!)
      }
    }),
  )
  return out
}

/**
 * Turns a PR's files into findings. Pure apart from the provider call, so the GitHub job, the CLI
 * and the evaluation suite all run exactly the same logic.
 */
export async function analyze(
  files: InputFile[],
  cfg: RepoConfig,
  opts: { provider: LlmProvider | null; prTitle?: string; maxPromptChars?: number; degradeOnLlmError?: boolean },
): Promise<Analysis> {
  const { prepared, skipped } = prepare(files, cfg)
  const notes: string[] = []
  const findings: Finding[] = []
  const byPath = new Map(prepared.map((p) => [p.path, p]))
  let linesReviewed = 0
  for (const p of prepared) linesReviewed += countChanges(p.hunks).added

  // 1. Deterministic rules.
  for (const p of prepared) {
    for (const hit of runRules(p.path, p.added, cfg.ruleEnabled)) {
      findings.push({
        path: p.path, line: hit.line, severity: hit.severity, category: hit.category, title: hit.title, body: hit.body,
        suggestion: hit.suggestion ?? null, confidence: hit.confidence, source: "rule", ruleId: hit.ruleId,
        fingerprint: fingerprint(p.path, hit.category, p.added.get(hit.line) ?? ""), outcome: "candidate",
      })
    }
  }

  // 2. Model review.
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0, model: opts.provider?.model ?? null }
  let mode: Analysis["mode"] = opts.provider ? "full" : "rules_only"
  let invalid = 0
  if (opts.provider && prepared.length) {
    const provider = opts.provider
    const system = systemPrompt(cfg)
    const batches = batchFiles(prepared, opts.maxPromptChars ?? 60_000)
    try {
      const responses = await mapLimit(batches, 3, (batch) => provider.review({ system, prompt: userPrompt(batch, opts.prTitle ?? "") }))
      for (const r of responses) {
        usage.calls++
        usage.inputTokens += r.inputTokens
        usage.outputTokens += r.outputTokens
        usage.model = r.model
        for (const raw of r.findings) {
          const parsed = ModelFindingSchema.safeParse(raw)
          if (!parsed.success) {
            invalid++
            continue
          }
          const f = parsed.data
          const file = byPath.get(f.path) ?? byPath.get(f.path.replace(/^\.?\//, ""))
          const lineText = file?.added.get(f.line)
          let suggestion = f.suggestion ?? null
          if (suggestion !== null && (suggestion.includes("\n") || suggestion === lineText)) suggestion = null
          findings.push({
            path: file?.path ?? f.path, line: lineText !== undefined ? f.line : null, severity: f.severity, category: f.category,
            title: f.title, body: f.explanation, suggestion, confidence: f.confidence, source: "llm", ruleId: null,
            fingerprint: fingerprint(file?.path ?? f.path, f.category, lineText ?? f.title),
            // The model must point at a line this PR added; anything else can't be anchored and is a hallucination risk.
            outcome: lineText === undefined ? "unanchored" : "candidate",
          })
        }
      }
    } catch (err) {
      if (!opts.degradeOnLlmError) throw err
      mode = "rules_only"
      notes.push(`The AI review failed (${err instanceof LlmError ? err.message : "unexpected error"}), so only the built-in checks ran.`)
    }
  }

  // 3. Filters from .diffwise.yml.
  for (const f of findings) {
    if (f.outcome !== "candidate") continue
    if (!cfg.categoryEnabled(f.category)) f.outcome = "disabled_category"
    else if (severityRank(f.severity) < severityRank(cfg.min_severity)) f.outcome = "below_threshold"
    else if (f.source === "llm" && f.confidence < cfg.min_confidence) f.outcome = "below_threshold"
  }

  // 4. One finding per line+category: a deterministic rule beats the model; otherwise keep the stronger one.
  const best = new Map<string, Finding>()
  for (const f of findings) {
    if (f.outcome !== "candidate") continue
    const key = `${f.path}:${f.line}:${f.category}`
    const prev = best.get(key)
    if (!prev) {
      best.set(key, f)
      continue
    }
    const better =
      prev.source !== f.source ? (f.source === "rule" ? f : prev) : severityRank(f.severity) !== severityRank(prev.severity) ? (severityRank(f.severity) > severityRank(prev.severity) ? f : prev) : f.confidence > prev.confidence ? f : prev
    const loser = better === f ? prev : f
    loser.outcome = "superseded_by_rule"
    best.set(key, better)
  }

  if (invalid) notes.push(`${invalid} malformed model finding${invalid === 1 ? " was" : "s were"} discarded.`)
  return {
    findings,
    reviewedFiles: prepared.map((p) => p.path),
    skippedFiles: skipped,
    linesReviewed,
    usage,
    mode,
    notes,
    invalidModelFindings: invalid,
  }
}

/**
 * Final selection: drop issues already posted on this PR (by fingerprint), rank the rest, post up
 * to max_comments inline and list the overflow in the summary.
 */
export function select(findings: Finding[], alreadyPosted: Set<string>, maxComments: number): Finding[] {
  const live = findings.filter((f) => f.outcome === "candidate")
  for (const f of live) if (alreadyPosted.has(f.fingerprint)) f.outcome = "duplicate"
  const ranked = live
    .filter((f) => f.outcome === "candidate")
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.source === b.source ? 0 : a.source === "rule" ? -1 : 1) || b.confidence - a.confidence || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
  ranked.forEach((f, i) => (f.outcome = i < maxComments ? "posted" : "summary"))
  return ranked
}
