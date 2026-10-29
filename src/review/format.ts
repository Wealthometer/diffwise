import type { FileSkip } from "./files.js"
import type { Analysis, Finding } from "./analyze.js"
import type { Severity } from "./repo-config.js"

const SEV: Record<Severity, string> = { critical: "🔴 Critical", high: "🟠 High", medium: "🟡 Medium", low: "⚪ Low" }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Escapes text so it can't break out of the markdown we wrap it in (titles come from a model). */
export const md = (s: string) => s.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/@(\w)/g, "@​$1")

export function commentBody(f: Finding): string {
  const parts = [`**${SEV[f.severity]} · ${cap(f.category)}** — ${md(f.title)}`, "", md(f.body)]
  if (f.suggestion !== null) parts.push("", "```suggestion", f.suggestion, "```")
  parts.push("", `<sub>Diffwise · ${f.source === "rule" ? `rule \`${f.ruleId}\`` : `${Math.round(f.confidence * 100)}% confidence`}</sub>`)
  return parts.join("\n")
}

export function summaryBody(a: Analysis, opts: { posted: Finding[]; overflow: Finding[]; duplicates: number; repoUrl: string; headSha: string; command: string; configError: string | null; reviewedAll: boolean }): string {
  const { posted, overflow } = opts
  const all = [...posted, ...overflow]
  const counts = (["critical", "high", "medium", "low"] as Severity[]).map((s) => [s, all.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0)

  const lines: string[] = []
  if (all.length === 0) {
    lines.push(`### ✅ Diffwise found no new issues`)
  } else {
    lines.push(`### Diffwise found ${all.length} issue${all.length === 1 ? "" : "s"}`)
    lines.push(counts.map(([s, n]) => `${SEV[s]} ${n}`).join(" · "))
  }
  lines.push("")
  lines.push(
    `Reviewed ${a.reviewedFiles.length} file${a.reviewedFiles.length === 1 ? "" : "s"} (${a.linesReviewed} added line${a.linesReviewed === 1 ? "" : "s"}) at ${opts.headSha.slice(0, 7)}` +
      (a.mode === "rules_only" ? " with the built-in checks only." : ` with the built-in checks and ${a.usage.model}.`),
  )
  if (opts.duplicates) lines.push(`${opts.duplicates} issue${opts.duplicates === 1 ? " was" : "s were"} already reported on an earlier commit and ${opts.duplicates === 1 ? "isn't" : "aren't"} repeated.`)

  if (overflow.length) {
    lines.push("", `<details><summary>${overflow.length} more issue${overflow.length === 1 ? "" : "s"} (over the comment limit)</summary>`, "")
    lines.push("| Severity | Location | Issue |", "| --- | --- | --- |")
    for (const f of overflow) {
      const loc = f.line ? `[\`${f.path}:${f.line}\`](${opts.repoUrl}/blob/${opts.headSha}/${f.path}#L${f.line})` : `\`${f.path}\``
      lines.push(`| ${SEV[f.severity]} | ${loc} | ${md(f.title).replace(/\|/g, "\\|")} |`)
    }
    lines.push("", "</details>")
  }

  const notes = [...a.notes, ...(opts.configError ? [opts.configError] : []), ...(opts.reviewedAll ? [] : ["Some inline comments couldn't be attached to the diff, so they're listed above instead."])]
  if (notes.length) lines.push("", ...notes.map((n) => `> ${n}`))

  if (a.skippedFiles.length) lines.push("", skippedDetails(a.skippedFiles))
  lines.push("", `<sub>Comment \`${opts.command} review\` to run again · configure with \`.diffwise.yml\`</sub>`)
  return lines.join("\n")
}

function skippedDetails(skipped: FileSkip[]): string {
  const rows = skipped.slice(0, 50).map((s) => `- \`${s.path}\`: ${s.reason}`)
  if (skipped.length > 50) rows.push(`- …and ${skipped.length - 50} more`)
  return [`<details><summary>${skipped.length} file${skipped.length === 1 ? "" : "s"} not reviewed</summary>`, "", ...rows, "", "</details>"].join("\n")
}
