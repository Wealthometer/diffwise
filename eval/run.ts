/**
 * Measures how often Diffwise is right.
 *
 *   npm run eval                                   # built-in rules only (free, no key)
 *   ANTHROPIC_API_KEY=… npm run eval -- --provider anthropic --record
 *   npm run eval -- --provider replay --recording eval/recordings/<file>.json --min-recall 0.8
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { AnthropicProvider } from "../src/review/llm/anthropic.js"
import type { LlmProvider } from "../src/review/llm/provider.js"
import { loadCases, recordingProvider, replayProvider, runEval, type Recording } from "./harness.js"

const here = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "rules" },
    model: { type: "string", default: process.env.LLM_MODEL ?? "claude-sonnet-5-5" },
    record: { type: "boolean", default: false },
    recording: { type: "string" },
    case: { type: "string" },
    "min-recall": { type: "string" },
    "min-precision": { type: "string" },
    "max-clean-noise": { type: "string" },
    json: { type: "boolean", default: false },
  },
})

let cases = await loadCases(join(here, "cases"))
if (values.case) cases = cases.filter((c) => c.id.includes(values.case!))

let provider: LlmProvider | null = null
let recording: Recording | null = null
if (values.provider === "anthropic") {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY to evaluate the model.")
  provider = new AnthropicProvider({ apiKey, model: values.model!, baseUrl: process.env.LLM_BASE_URL ?? "https://api.anthropic.com", maxOutputTokens: 4096, timeoutMs: 120_000 })
  if (values.record) {
    recording = { model: values.model!, createdAt: new Date().toISOString(), responses: {} }
    provider = recordingProvider(provider, recording)
  }
} else if (values.provider === "replay") {
  if (!values.recording) throw new Error("--provider replay needs --recording <file>")
  provider = replayProvider(JSON.parse(await readFile(values.recording, "utf8")) as Recording)
} else if (values.provider !== "rules") {
  throw new Error(`Unknown provider "${values.provider}" (use rules, anthropic or replay)`)
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
if (!values.json) console.log(`\nDiffwise eval · ${cases.length} cases · provider: ${values.provider}${provider ? ` (${provider.model})` : ""}\n`)

const { results, summary } = await runEval(cases, provider, (r) => {
  if (values.json) return
  const mark = r.clean ? (r.falsePositives.length ? "✗ noisy" : "✓ quiet") : r.missed.length ? (r.truePositives ? "◐ partial" : "✗ missed") : "✓ found"
  const extra = r.falsePositives.length ? `  +${r.falsePositives.length} false positive${r.falsePositives.length > 1 ? "s" : ""} (${r.falsePositives.map((f) => f.source).join(", ")})` : ""
  console.log(`${mark.padEnd(10)} ${r.id}${extra}`)
})

if (values.json) console.log(JSON.stringify({ summary, results }, null, 2))
else {
  console.log(`
| Metric | Value |
| --- | --- |
| Precision (reported issues that are real) | ${pct(summary.precision)} |
| Recall (real issues that were reported) | ${pct(summary.recall)} |
| F1 | ${pct(summary.f1)} |
| Clean PRs with any comment | ${pct(summary.cleanPrNoiseRate)} (${summary.cleanCases} clean cases) |
| True / false positives, missed | ${summary.truePositives} / ${summary.falsePositives} / ${summary.missed} |
| Duplicate comments on a real issue | ${summary.duplicates} |
| Tokens | ${summary.totalTokens.toLocaleString("en")} |
`)
}

await mkdir(join(here, "results"), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
await writeFile(join(here, "results", `${stamp}-${values.provider}.json`), JSON.stringify({ summary, results }, null, 2))
if (recording) {
  const file = join(here, "recordings", `${values.model}-${stamp}.json`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(recording, null, 2))
  console.log(`Recorded ${Object.keys(recording.responses).length} responses to ${file}`)
}

// CI gates
const fails: string[] = []
if (values["min-recall"] && summary.recall < Number(values["min-recall"])) fails.push(`recall ${pct(summary.recall)} < ${values["min-recall"]}`)
if (values["min-precision"] && summary.precision < Number(values["min-precision"])) fails.push(`precision ${pct(summary.precision)} < ${values["min-precision"]}`)
if (values["max-clean-noise"] && summary.cleanPrNoiseRate > Number(values["max-clean-noise"])) fails.push(`clean-PR noise ${pct(summary.cleanPrNoiseRate)} > ${values["max-clean-noise"]}`)
if (fails.length) {
  console.error(`Eval gate failed: ${fails.join("; ")}`)
  process.exit(1)
}
