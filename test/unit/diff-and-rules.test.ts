import { describe, expect, it } from "vitest"
import { addedLines, parsePatch } from "../../src/review/diff.js"
import { DEFAULT_CONFIG, parseRepoConfig } from "../../src/review/repo-config.js"
import { runRules } from "../../src/review/rules.js"

describe("parsePatch", () => {
  const patch = [
    "@@ -10,4 +10,5 @@ export function total(items) {",
    "   let sum = 0",
    "-  for (let i = 0; i <= items.length; i++) {",
    "+  for (let i = 0; i < items.length; i++) {",
    "+    if (!items[i]) continue",
    "     sum += items[i].price",
    "   }",
    "@@ -40,2 +41,3 @@",
    "   return sum",
    "+  // done",
    " }",
    "\\ No newline at end of file",
  ].join("\n")

  it("numbers added and context lines on the new side", () => {
    const hunks = parsePatch(patch)
    expect(hunks).toHaveLength(2)
    expect([...addedLines(hunks)]).toEqual([
      [11, "  for (let i = 0; i < items.length; i++) {"],
      [12, "    if (!items[i]) continue"],
      [42, "  // done"],
    ])
    const ctx = hunks[0]!.lines.filter((l) => l.kind === "ctx").map((l) => (l as { newLine: number }).newLine)
    expect(ctx).toEqual([10, 13, 14])
  })

  it("handles new files and ignores the no-newline marker", () => {
    const hunks = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file")
    expect([...addedLines(hunks).keys()]).toEqual([1, 2])
  })
})

const lines = (...l: string[]) => new Map(l.map((t, i) => [i + 1, t]))
const hits = (path: string, ...l: string[]) => runRules(path, lines(...l), DEFAULT_CONFIG.ruleEnabled).map((h) => h.ruleId)

describe("built-in rules", () => {
  it.each([
    ["src/aws.ts", 'const key = "AKIAIOSFODNN7EXAMPLF"', "hardcoded-secret"],
    ["src/gh.ts", "const t = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'", "hardcoded-secret"],
    ["config.py", 'DB_PASSWORD = "s3cr3t-Pa55word!"', "hardcoded-secret"],
    ["deploy/key.pem", "-----BEGIN RSA PRIVATE KEY-----", "private-key"],
    ["src/http.ts", "const agent = new https.Agent({ rejectUnauthorized: false })", "tls-verification-disabled"],
    ["app.py", "requests.get(url, verify=False)", "tls-verification-disabled"],
    ["src/db.ts", 'db.query("SELECT * FROM users WHERE id = " + req.params.id)', "sql-injection"],
    ["src/db.ts", "db.query(`DELETE FROM sessions WHERE user = ${userId}`)", "sql-injection"],
    ["repo.py", 'cursor.execute(f"SELECT * FROM orders WHERE email = \'{email}\'")', "sql-injection"],
    ["repo.py", 'cursor.execute("SELECT * FROM t WHERE a = %s" % value)', "sql-injection"],
    ["src/calc.js", "const result = eval(userExpression)", "dynamic-code-execution"],
    ["tool.py", "exec(payload)", "dynamic-code-execution"],
    ["src/view.ts", "el.innerHTML = comment.body", "unsafe-html"],
    ["src/c.tsx", "<div dangerouslySetInnerHTML={{ __html: bio }} />", "unsafe-html"],
    ["src/auth.ts", "const hashed = crypto.createHash('md5').update(password).digest('hex')", "weak-hash"],
    ["src/job.ts", "try { await send() } catch (e) {}", "empty-catch"],
    ["worker.py", "except Exception: pass", "empty-catch"],
    ["src/app.ts", "  debugger", "debugger-statement"],
  ])("%s: %s → %s", (path, line, rule) => {
    expect(hits(path, line)).toContain(rule)
  })

  it.each([
    ["src/cfg.ts", 'const password = process.env.DB_PASSWORD ?? ""'],
    ["src/cfg.ts", 'password: "changeme-in-production"'],
    ["src/cfg.ts", 'apiKey: "<your-api-key>"'],
    ["src/db.ts", 'db.query("SELECT * FROM users WHERE id = $1", [id])'],
    ["src/db.ts", "const label = 'Select an option' + suffix"],
    ["src/view.ts", 'el.innerHTML = ""'],
    ["src/view.ts", "el.textContent = comment.body"],
    ["src/sum.ts", "const checksum = crypto.createHash('sha256').update(buf)"],
    ["src/job.ts", "} catch (err) { logger.warn(err) }"],
    ["src/app.ts", "const debuggerEnabled = true"],
    ["src/math.ts", "const value = model.evaluate(x)"],
    ["README.md", "Use eval() carefully"],
  ])("does not flag %s: %s", (path, line) => {
    expect(hits(path, line)).toEqual([])
  })

  it("is quieter about secrets in tests", () => {
    const [prod] = runRules("src/a.ts", lines('const token = "abcd1234efgh5678"'), DEFAULT_CONFIG.ruleEnabled)
    const [test] = runRules("src/a.test.ts", lines('const token = "abcd1234efgh5678"'), DEFAULT_CONFIG.ruleEnabled)
    expect(prod!.severity).toBe("high")
    expect(test!.severity).toBe("low")
  })

  it("keeps console.log off unless enabled", () => {
    expect(hits("src/a.ts", "console.log(user)")).toEqual([])
    const { config } = parseRepoConfig("rules:\n  console-log: true")
    expect(runRules("src/a.ts", lines("console.log(user)"), config.ruleEnabled).map((h) => h.ruleId)).toEqual(["console-log"])
  })
})

describe(".diffwise.yml", () => {
  it("uses safe defaults", () => {
    const { config, error } = parseRepoConfig(null)
    expect(error).toBeNull()
    expect(config).toMatchObject({ min_severity: "medium", min_confidence: 0.7, max_comments: 10 })
    expect(config.categoryEnabled("security")).toBe(true)
    expect(config.categoryEnabled("style")).toBe(false)
  })

  it("applies overrides", () => {
    const { config } = parseRepoConfig("min_severity: high\ncategories:\n  style: true\n  performance: false\nignore: ['docs/**']\ninstructions: Prefer early returns")
    expect(config.min_severity).toBe("high")
    expect(config.categoryEnabled("style")).toBe(true)
    expect(config.categoryEnabled("performance")).toBe(false)
    expect(config.ignore).toEqual(["docs/**"])
  })

  it("falls back to defaults with a readable error on bad input", () => {
    expect(parseRepoConfig("min_severity: urgent").error).toMatch(/min_severity/)
    expect(parseRepoConfig("max_comments: [").error).toMatch(/not valid YAML/)
    expect(parseRepoConfig("unknown_key: 1").error).toMatch(/Unrecognized key/)
  })
})
