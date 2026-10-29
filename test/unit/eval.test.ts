import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadCases, recordingProvider, replayProvider, runEval, type EvalCase, type Recording } from "../../eval/harness.js"
import type { LlmProvider } from "../../src/review/llm/provider.js"

const cases = await loadCases(join(import.meta.dirname, "../../eval/cases"))

/** A provider that knows the answers: returns each case's labelled issues. Validates the scoring. */
function oracle(all: EvalCase[], extra: (c: EvalCase) => unknown[] = () => []): LlmProvider {
  return {
    name: "oracle",
    model: "oracle",
    async review({ prompt }) {
      const c = all.find((x) => x.files.every((f) => prompt.includes(`path="${f.path}"`)) && x.files.some((f) => prompt.includes(f.patch.split("\n").find((l) => l.startsWith("+"))!.slice(1))))!
      return {
        findings: [...c.expected.map((e) => ({ path: e.path, line: e.lines[0], severity: "high", category: e.category ?? "bug", title: "x", explanation: "y", confidence: 0.95 })), ...extra(c)],
        inputTokens: 10,
        outputTokens: 5,
        model: "oracle",
      }
    },
  }
}

describe("evaluation suite", () => {
  it("has a balanced, valid dataset", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25)
    expect(cases.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(10)
    for (const c of cases) for (const e of c.expected) expect(e.lines.length).toBeGreaterThan(0)
  })

  it("rules-only baseline stays precise and quiet (regression guard)", async () => {
    const { summary } = await runEval(cases, null)
    expect(summary.precision).toBe(1)
    expect(summary.cleanPrNoiseRate).toBe(0)
    expect(summary.recall).toBeGreaterThanOrEqual(0.45)
  })

  it("scores a perfect reviewer as perfect", async () => {
    const { summary } = await runEval(cases, oracle(cases))
    expect(summary).toMatchObject({ precision: 1, recall: 1, cleanPrNoiseRate: 0, missed: 0, falsePositives: 0 })
  })

  it("counts noise on clean PRs and invented lines correctly", async () => {
    const noisy = oracle(cases, (c) => [{ path: c.files[0]!.path, line: [...c.files[0]!.patch.matchAll(/^\+/gm)].length > 0 ? 1 : 1, severity: "high", category: "bug", title: "nit", explanation: "nit", confidence: 0.9 }])
    const { summary, results } = await runEval(cases, noisy)
    // Line 1 is usually context, not an added line, so most of these are dropped as unanchored — by design.
    expect(summary.recall).toBe(1)
    const clean = results.filter((r) => r.clean)
    expect(clean.every((r) => r.falsePositives.every((f) => f.line !== null))).toBe(true)
  })

  it("records model responses and replays them deterministically", async () => {
    const rec: Recording = { model: "oracle", createdAt: "", responses: {} }
    const live = await runEval(cases.slice(0, 5), recordingProvider(oracle(cases), rec))
    expect(Object.keys(rec.responses)).toHaveLength(5)
    const replayed = await runEval(cases.slice(0, 5), replayProvider(rec))
    expect(replayed.summary).toMatchObject({ precision: live.summary.precision, recall: live.summary.recall })
    await expect(runEval(cases.slice(5, 6), replayProvider(rec))).rejects.toThrow(/re-record/)
  })
})
