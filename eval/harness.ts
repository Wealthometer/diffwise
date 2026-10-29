import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { analyze, select, type Finding } from "../src/review/analyze.js"
import { addedLines, parsePatch } from "../src/review/diff.js"
import type { LlmProvider, ReviewRequest, ReviewResponse } from "../src/review/llm/provider.js"
import { DEFAULT_CONFIG, parseRepoConfig } from "../src/review/repo-config.js"

/**
 * A case is a small PR with labelled ground truth. Expected issues are anchored by the code they
 * sit on ("on_any_line_containing"), which the loader resolves to line numbers, so editing a case
 * can't silently break its labels.
 */
export type EvalCase = {
  id: string
  description: string
  files: { path: string; patch: string; status?: string }[]
  expected: { path: string; lines: number[]; category?: string }[]
  config?: string
}

type RawCase = {
  description: string
  files: { path: string; patch: string; status?: string }[]
  expected: { path: string; on_any_line_containing: string[]; category?: string }[]
  config?: string
}

export async function loadCases(dir: string): Promise<EvalCase[]> {
  const cases: EvalCase[] = []
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()) {
    const id = file.replace(/\.yaml$/, "")
    const raw = parseYaml(await readFile(join(dir, file), "utf8")) as RawCase
    const expected = (raw.expected ?? []).map((e) => {
      const f = raw.files.find((x) => x.path === e.path)
      if (!f) throw new Error(`${id}: expected issue in ${e.path}, which isn't in the case`)
      const added = addedLines(parsePatch(f.patch))
      const lines = [...added].filter(([, text]) => e.on_any_line_containing.some((needle) => text.includes(needle))).map(([n]) => n)
      if (!lines.length) throw new Error(`${id}: none of ${JSON.stringify(e.on_any_line_containing)} is on an added line of ${e.path}`)
      return { path: e.path, lines, category: e.category }
    })
    cases.push({ id, description: raw.description, files: raw.files, expected, config: raw.config })
  }
  return cases
}

export type CaseResult = {
  id: string
  clean: boolean
  expected: number
  truePositives: number
  falsePositives: { path: string; line: number | null; title: string; source: string }[]
  /** Extra comments about an issue that was already matched. */
  duplicates: number
  missed: { path: string; lines: number[] }[]
  categoryAgreement: number
  inputTokens: number
  outputTokens: number
  ms: number
}

export type Summary = {
  provider: string
  model: string | null
  cases: number
  cleanCases: number
  precision: number
  recall: number
  f1: number
  /** Share of clean PRs where the reviewer posted anything at all. */
  cleanPrNoiseRate: number
  falsePositives: number
  duplicates: number
  missed: number
  truePositives: number
  totalTokens: number
  avgMsPerCase: number
}

const TOLERANCE = 1 // a finding one line away from the labelled line still counts

export function score(c: EvalCase, reported: Finding[]): Omit<CaseResult, "inputTokens" | "outputTokens" | "ms"> {
  const used = new Set<Finding>()
  let tp = 0
  let catOk = 0
  const missed: CaseResult["missed"] = []
  for (const e of c.expected) {
    const hit = reported.find((f) => !used.has(f) && f.path === e.path && f.line !== null && e.lines.some((l) => Math.abs(l - f.line!) <= TOLERANCE))
    if (hit) {
      used.add(hit)
      tp++
      if (!e.category || e.category === hit.category) catOk++
    } else missed.push({ path: e.path, lines: e.lines })
  }
  const matchesSomeExpected = (f: Finding) => c.expected.some((e) => f.path === e.path && f.line !== null && e.lines.some((l) => Math.abs(l - f.line!) <= TOLERANCE))
  const rest = reported.filter((f) => !used.has(f))
  // A second comment about an issue that's real is redundant, not invented: tracked, but not a false positive.
  const duplicates = rest.filter(matchesSomeExpected).length
  const fps = rest.filter((f) => !matchesSomeExpected(f)).map((f) => ({ path: f.path, line: f.line, title: f.title, source: f.source === "rule" ? `rule:${f.ruleId}` : "model" }))
  return { id: c.id, clean: c.expected.length === 0, expected: c.expected.length, truePositives: tp, falsePositives: fps, duplicates, missed, categoryAgreement: catOk }
}

export async function runEval(cases: EvalCase[], provider: LlmProvider | null, onCase?: (r: CaseResult) => void): Promise<{ results: CaseResult[]; summary: Summary }> {
  const results: CaseResult[] = []
  let model: string | null = null
  for (const c of cases) {
    const started = performance.now()
    const cfg = c.config ? parseRepoConfig(c.config).config : DEFAULT_CONFIG
    const analysis = await analyze(c.files.map((f) => ({ path: f.path, status: f.status ?? "modified", patch: f.patch })), cfg, { provider, prTitle: c.description })
    model = analysis.usage.model ?? model
    // Everything that would reach the PR, inline or in the summary.
    const reported = select(analysis.findings, new Set(), 1000)
    const r = { ...score(c, reported), inputTokens: analysis.usage.inputTokens, outputTokens: analysis.usage.outputTokens, ms: Math.round(performance.now() - started) }
    results.push(r)
    onCase?.(r)
  }
  const tp = results.reduce((n, r) => n + r.truePositives, 0)
  const fp = results.reduce((n, r) => n + r.falsePositives.length, 0)
  const fn = results.reduce((n, r) => n + r.missed.length, 0)
  const clean = results.filter((r) => r.clean)
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return {
    results,
    summary: {
      provider: provider?.name ?? "rules",
      model,
      cases: results.length,
      cleanCases: clean.length,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      cleanPrNoiseRate: clean.length ? clean.filter((r) => r.falsePositives.length > 0).length / clean.length : 0,
      falsePositives: fp,
      duplicates: results.reduce((n, r) => n + r.duplicates, 0),
      missed: fn,
      truePositives: tp,
      totalTokens: results.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
      avgMsPerCase: Math.round(results.reduce((n, r) => n + r.ms, 0) / Math.max(1, results.length)),
    },
  }
}

// ── Recording and replay ────────────────────────────────────────────────────
// Record real model responses once (costs tokens), then replay them in CI for free, deterministic
// regression checks of everything around the model: parsing, anchoring, filters, ranking, scoring.

const promptKey = (req: ReviewRequest) => createHash("sha256").update(req.system).update("\u0000").update(req.prompt).digest("hex").slice(0, 24)

export type Recording = { model: string; createdAt: string; responses: Record<string, ReviewResponse> }

export function recordingProvider(inner: LlmProvider, sink: Recording): LlmProvider {
  return {
    name: inner.name,
    model: inner.model,
    async review(req) {
      const res = await inner.review(req)
      sink.responses[promptKey(req)] = res
      return res
    },
  }
}

export function replayProvider(rec: Recording): LlmProvider {
  return {
    name: "replay",
    model: rec.model,
    async review(req) {
      const hit = rec.responses[promptKey(req)]
      if (!hit) throw new Error("No recorded response for this prompt. The prompt or a case changed; re-record with --provider anthropic --record.")
      return hit
    },
  }
}
