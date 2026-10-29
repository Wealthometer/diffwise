/**
 * Runs fake GitHub + fake Anthropic on fixed ports for local demos and manual end-to-end runs:
 *
 *   npx tsx test/fakes/serve.ts            # prints the env vars to start web + worker with
 *
 * The fake model "finds" the bugs labelled in eval/cases, so the dashboard has realistic data
 * without an API key. It only knows those cases.
 */
import { generateKeyPairSync } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadCases } from "../../eval/harness.js"
import { FakeAnthropic } from "./anthropic.js"
import { FakeGitHub } from "./github.js"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const cases = await loadCases(join(import.meta.dirname, "../../eval/cases"))

const TITLES: Record<string, string> = {
  "bug-off-by-one": "Loop bound reads one element past the end of the array",
  "bug-missing-await": "findById returns a Promise here, so the 404 branch can never run",
  "bug-race-balance": "Balance check and update aren't atomic; concurrent withdrawals can overdraw",
  "bug-fire-and-forget": "forEach doesn't await async callbacks; saves run after the function returns",
  "bug-pagination-skips": "With 1-based pages, page 1 starts at offset 20 and skips the first page",
  "bug-go-ignored-error": "Read error is discarded; a missing file silently becomes an empty config",
  "bug-java-resource-leak": "Reader is never closed; use try-with-resources",
  "bug-py-mutable-default": "Default list is shared between calls",
  "bug-assignment-in-condition": "Assignment instead of comparison makes every user an admin",
}

const llm = new FakeAnthropic(({ prompt }) => {
  const c = cases.find((x) => x.expected.length && x.files.every((f) => prompt.includes(`path="${f.path}"`)) && x.files.some((f) => prompt.includes(f.patch.split("\n").find((l) => l.startsWith("+"))!.slice(1))))
  if (!c || !TITLES[c.id]) return []
  return c.expected.map((e) => ({
    path: e.path, line: e.lines[0], severity: c.id.includes("assignment") || c.id.includes("race") ? "critical" : "high", category: e.category ?? "bug",
    title: TITLES[c.id], explanation: c.description, confidence: 0.88,
  }))
}, "demo-key")

const gh = new FakeGitHub(publicKey)
gh.oauth.installations = [77]
gh.oauth.user = { id: 9001, login: "ada", name: "Ada", avatar_url: null }
await Promise.all([gh.start(), llm.start()])

// Expose PRs: one per case, numbered in order, all at head sha "sha-<n>".
cases.forEach((c, i) => gh.addPr("acme/shop", { number: i + 1, title: c.description.replace(/\.$/, ""), headSha: `sha${String(i + 1).padStart(4, "0")}`, author: ["ada", "grace", "linus", "margaret"][i % 4], files: c.files.map((f) => ({ filename: f.path, patch: f.patch })) }))
writeFileSync("/tmp/diffwise-demo-key.pem", privateKey)
console.log(JSON.stringify({ github: gh.url, anthropic: llm.url, privateKeyFile: "/tmp/diffwise-demo-key.pem", prs: cases.map((c, i) => ({ number: i + 1, id: c.id })) }))
setInterval(() => {}, 1 << 30)
