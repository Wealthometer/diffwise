/**
 * Parses GitHub's per-file unified diff ("patch") into hunks with line numbers.
 * Only added lines (right side, "+") are offered for comments: that's where the PR author can act.
 */
export type DiffLine =
  | { kind: "add"; newLine: number; text: string }
  | { kind: "ctx"; newLine: number; oldLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string }

export type Hunk = { header: string; oldStart: number; newStart: number; lines: DiffLine[] }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | undefined
  let oldN = 0
  let newN = 0
  for (const raw of patch.split("\n")) {
    const m = raw.match(HUNK_HEADER)
    if (m) {
      oldN = Number(m[1])
      newN = Number(m[2])
      cur = { header: raw, oldStart: oldN, newStart: newN, lines: [] }
      hunks.push(cur)
      continue
    }
    if (!cur || raw.startsWith("\\")) continue // "\ No newline at end of file"
    const sign = raw[0]
    const text = raw.slice(1)
    if (sign === "+") cur.lines.push({ kind: "add", newLine: newN++, text })
    else if (sign === "-") cur.lines.push({ kind: "del", oldLine: oldN++, text })
    else if (sign === " " || raw === "") cur.lines.push({ kind: "ctx", newLine: newN++, oldLine: oldN++, text })
  }
  // A trailing empty string from split() is not a real context line.
  for (const h of hunks) {
    const last = h.lines.at(-1)
    if (last?.kind === "ctx" && last.text === "" && patch.endsWith("\n")) h.lines.pop()
  }
  return hunks
}

/** new-file line number → text, for every added line. */
export function addedLines(hunks: Hunk[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const h of hunks) for (const l of h.lines) if (l.kind === "add") out.set(l.newLine, l.text)
  return out
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) for (const l of h.lines) l.kind === "add" ? added++ : l.kind === "del" ? removed++ : 0
  return { added, removed }
}
