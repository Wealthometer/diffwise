import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { closeDb, db } from "../../src/db/pool.js"
import { buildApp } from "../../src/web/app.js"
import { FakeAnthropic } from "../fakes/anthropic.js"
import { FakeGitHub } from "../fakes/github.js"
import { drain, installation, prEvent, repo, resetDb, useEnv, webhook } from "../helpers.js"

const gh = new FakeGitHub(process.env.TEST_GITHUB_PUBLIC_KEY!)
// The fake model "finds" the off-by-one whenever it sees `<= items.length` on an added line.
const llm = new FakeAnthropic(({ prompt }) => {
  const m = prompt.match(/\+\s*(\d+) \|.*<= items\.length/)
  return m
    ? [{ path: "src/cart.ts", line: Number(m[1]), severity: "high", category: "bug", title: "Loop reads one past the end of items", explanation: "With `<=`, the last iteration reads items[items.length], which is undefined, so `.price` throws.", suggestion: "  for (let i = 0; i < items.length; i++) {", confidence: 0.93 }]
    : []
})

let app: Awaited<ReturnType<typeof buildApp>>

const cartPatch = (start = 10) =>
  `@@ -${start},3 +${start},5 @@ export function total(items) {\n   let total = 0\n+  for (let i = 0; i <= items.length; i++) {\n+    total += items[i].price\n+  }\n   return total`
const dbPatch = `@@ -1,2 +1,3 @@\n import { db } from "./db"\n+export const find = (id) => db.query("SELECT * FROM orders WHERE id = " + id)\n export {}`

beforeAll(async () => {
  await Promise.all([gh.start(), llm.start()])
  useEnv({ GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url, ANTHROPIC_API_KEY: "test-key", LLM_BASE_URL: llm.url, LLM_MODEL: "claude-test" })
  app = await buildApp()
})
afterAll(async () => {
  await app.close()
  await Promise.all([gh.stop(), llm.stop()])
  await closeDb()
})
beforeEach(async () => {
  await resetDb()
  gh.reviews.length = 0
  gh.issueComments.length = 0
  gh.reactions.length = 0
  gh.contents.clear()
  llm.requests.length = 0
  llm.failures = []
  gh.addPr(repo.full_name, { number: 1, title: "Add cart total", headSha: "aaa111", files: [{ filename: "src/cart.ts", patch: cartPatch() }, { filename: "src/orders.ts", patch: dbPatch }, { filename: "package-lock.json", patch: "@@ -1 +1,2 @@\n {\n+  \"x\": 1" }] })
})

const reviewRow = async () => (await db().query("SELECT * FROM reviews ORDER BY created_at DESC LIMIT 1")).rows[0]

describe("webhook endpoint", () => {
  it("rejects unsigned or wrongly signed deliveries", async () => {
    expect((await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }), { secret: "wrong" })).status).toBe(401)
    expect((await db().query("SELECT count(*)::int n FROM jobs")).rows[0].n).toBe(0)
  })

  it("processes a redelivered webhook only once", async () => {
    const payload = prEvent("opened", { number: 1, headSha: "aaa111" })
    expect((await webhook(app, "pull_request", payload, { delivery: "same" })).body.outcome).toBe("queued")
    expect((await webhook(app, "pull_request", payload, { delivery: "same" })).body.outcome).toBe("duplicate")
    expect((await db().query("SELECT count(*)::int n FROM jobs")).rows[0].n).toBe(1)
  })

  it("records installations and their repositories", async () => {
    await webhook(app, "installation", { action: "created", installation, repositories: [repo, { id: 556, full_name: "acme/api" }] })
    const repos = await db().query("SELECT full_name FROM repositories ORDER BY id")
    expect(repos.rows.map((r) => r.full_name)).toEqual(["acme/shop", "acme/api"])
  })

  it("ignores drafts until they're ready for review", async () => {
    expect((await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111", draft: true }))).body.outcome).toBe("ignored")
    expect((await webhook(app, "pull_request", prEvent("ready_for_review", { number: 1, headSha: "aaa111", draft: false }))).body.outcome).toBe("queued")
  })
})

describe("review of a pull request", () => {
  it("posts one review with inline comments on the exact lines, plus a summary", async () => {
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    expect(await drain()).toEqual({ done: 1, failed: [] })

    expect(gh.reviews).toHaveLength(1)
    const review = gh.reviews[0]!
    expect(review.commit_id).toBe("aaa111")
    const comments = review.comments.map((c) => `${c.path}:${c.line}`).sort()
    expect(comments).toEqual(["src/cart.ts:11", "src/orders.ts:2"])
    expect(review.comments.find((c) => c.path === "src/cart.ts")!.body).toContain("```suggestion\n  for (let i = 0; i < items.length; i++) {\n```")
    expect(review.comments.find((c) => c.path === "src/orders.ts")!.body).toContain("rule `sql-injection`")
    expect(review.body).toContain("Diffwise found 2 issues")
    expect(review.body).toMatch(/package-lock\.json`: generated or lock file/)

    // The model saw only reviewable files, with explicit line numbers, and was forced to use the tool.
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]!.prompt).not.toContain("package-lock.json")
    expect(llm.requests[0]!.toolChoice).toEqual({ type: "tool", name: "report_findings" })

    expect(await reviewRow()).toMatchObject({ status: "completed", mode: "full", model: "claude-test", findings_count: 2, comments_posted: 2, files_reviewed: 2, files_skipped: 1, github_review_id: 5001 })
    expect(Number((await reviewRow()).cost_usd)).toBeGreaterThan(0)
  })

  it("does not repeat itself when a later push still contains the same issues", async () => {
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    // New commit: unrelated lines added above shift the issue from line 11 to line 41.
    gh.addPr(repo.full_name, { number: 1, title: "Add cart total", headSha: "bbb222", files: [{ filename: "src/cart.ts", patch: cartPatch(40) }, { filename: "src/orders.ts", patch: dbPatch }] })
    await webhook(app, "pull_request", prEvent("synchronize", { number: 1, headSha: "bbb222" }))
    await drain()

    expect(gh.reviews).toHaveLength(1) // nothing new → stays quiet
    const second = await reviewRow()
    expect(second).toMatchObject({ head_sha: "bbb222", status: "completed", comments_posted: 0, github_review_id: null })
    const outcomes = await db().query("SELECT outcome FROM findings WHERE review_id = $1", [second.id])
    expect(outcomes.rows.map((r) => r.outcome).sort()).toEqual(["duplicate", "duplicate"])
  })

  it("collapses a burst of pushes into one review of the latest commit", async () => {
    gh.addPr(repo.full_name, { number: 1, title: "x", headSha: "ccc333", files: [{ filename: "src/cart.ts", patch: cartPatch() }] })
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await webhook(app, "pull_request", prEvent("synchronize", { number: 1, headSha: "bbb222" }))
    await webhook(app, "pull_request", prEvent("synchronize", { number: 1, headSha: "ccc333" }))
    await drain()
    const rows = await db().query("SELECT head_sha, status FROM reviews ORDER BY created_at")
    expect(rows.rows).toEqual([
      { head_sha: "aaa111", status: "superseded" },
      { head_sha: "bbb222", status: "superseded" },
      { head_sha: "ccc333", status: "completed" },
    ])
    expect(gh.reviews).toHaveLength(1)
    expect(llm.requests).toHaveLength(1)
  })

  it("re-runs on '/diffwise review' from a collaborator, not from strangers", async () => {
    const comment = (association: string, id: number) => ({
      action: "created", installation, repository: repo,
      issue: { number: 1, title: "Add cart total", pull_request: {}, user: { login: "dev" } },
      comment: { id, body: "/diffwise review please", author_association: association },
    })
    expect((await webhook(app, "issue_comment", comment("NONE", 1))).body.outcome).toBe("ignored")
    expect((await webhook(app, "issue_comment", comment("MEMBER", 2))).body.outcome).toBe("queued")
    await drain()
    expect(gh.reactions).toEqual([{ repo: "acme/shop", commentId: 2, content: "eyes" }])
    expect(gh.reviews).toHaveLength(1)
    expect(await reviewRow()).toMatchObject({ trigger: "command", head_sha: "aaa111", status: "completed" })
  })

  it("reads .diffwise.yml from the base branch", async () => {
    gh.contents.set("acme/shop:main:.diffwise.yml", "categories:\n  bug: false\nmin_severity: high")
    gh.contents.set("acme/shop:feature:.diffwise.yml", "enabled: false") // the PR's own copy is ignored
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    expect(gh.reviews[0]!.comments.map((c) => c.path)).toEqual(["src/orders.ts"]) // bug category off
    expect(llm.requests[0]!.system).not.toMatch(/one of: bug/)
  })

  it("explains a broken config instead of failing", async () => {
    gh.contents.set("acme/shop:main:.diffwise.yml", "max_comments: lots")
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    expect(gh.reviews[0]!.body).toMatch(/> \.diffwise\.yml: max_comments: .*Defaults were used/)
  })

  it("rides out model overloads with retries", async () => {
    llm.failures = [529, 529]
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    expect(await reviewRow()).toMatchObject({ status: "completed", mode: "full" })
  })

  it("falls back to the built-in checks when the model keeps failing on the last attempt", async () => {
    llm.failures = Array(40).fill(529)
    useEnv({ LLM_MAX_RETRIES: "0" })
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    const result = await drain()
    useEnv({ LLM_MAX_RETRIES: undefined })
    expect(result.failed.length).toBeGreaterThan(0) // earlier attempts retried
    expect(await reviewRow()).toMatchObject({ status: "completed", mode: "rules_only" })
    expect(gh.reviews[0]!.body).toMatch(/AI review failed/)
    expect(gh.reviews[0]!.comments.map((c) => c.path)).toEqual(["src/orders.ts"])
    llm.failures = []
  })

  it("retries GitHub outages and never double-posts", async () => {
    gh.failNext = { path: /\/pulls\/1$/, status: 502, times: 1 }
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    const r = await drain()
    expect(r.failed[0]).toMatch(/502/)
    expect(gh.reviews).toHaveLength(1)
    expect(await reviewRow()).toMatchObject({ status: "completed" })
  })

  it("moves comments into the summary if GitHub rejects their position", async () => {
    // The model points at a context line; we drop it as unanchored, so force a bad line differently:
    // simulate GitHub rejecting by making the diff it holds differ from the one it served.
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    const pr = gh.prs.get("acme/shop#1")!
    const originalFiles = pr.files
    type Route = (req: { url: string; method: string }, raw: string) => unknown
    const serve = gh as unknown as { route: Route }
    const route: Route = serve.route.bind(gh)
    serve.route = (req, raw) => {
      if (req.method === "POST" && req.url.endsWith("/reviews")) pr.files = [{ filename: "src/cart.ts", patch: "@@ -1 +1 @@\n-x\n+y" }]
      const out = route(req, raw)
      pr.files = originalFiles
      return out
    }
    await drain()
    serve.route = route
    expect(gh.reviews).toHaveLength(1)
    expect(gh.reviews[0]!.comments).toHaveLength(0)
    expect(gh.reviews[0]!.body).toMatch(/couldn't be attached/)
    expect(await reviewRow()).toMatchObject({ status: "completed", comments_posted: 0 })
  })

  it("skips very large PRs with a short explanation", async () => {
    useEnv({ MAX_PR_CHANGED_LINES: "2" })
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    useEnv({ MAX_PR_CHANGED_LINES: undefined })
    expect(gh.reviews).toHaveLength(0)
    expect(gh.issueComments[0]!.body).toMatch(/skipped this pull request because it changes \d+ lines/)
    expect(await reviewRow()).toMatchObject({ status: "skipped" })
  })

  it("enforces the monthly AI budget but keeps the free checks running", async () => {
    await webhook(app, "installation", { action: "created", installation, repositories: [repo] })
    await db().query("UPDATE installations SET monthly_review_limit = 0")
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    expect(llm.requests).toHaveLength(0)
    expect(await reviewRow()).toMatchObject({ mode: "rules_only", status: "completed" })
    expect(gh.reviews[0]!.body).toMatch(/used its AI review allowance/)
  })

  it("counts usage per installation per month", async () => {
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await drain()
    const u = (await db().query("SELECT reviews, input_tokens, output_tokens FROM usage_monthly")).rows[0]
    expect(u.reviews).toBe(1)
    expect(u.input_tokens).toBeGreaterThan(0)
  })

  it("cancels pending reviews when the PR is closed", async () => {
    useEnv({ REVIEW_DEBOUNCE_SECONDS: "60" })
    await webhook(app, "pull_request", prEvent("opened", { number: 1, headSha: "aaa111" }))
    await webhook(app, "pull_request", { ...prEvent("closed", { number: 1, headSha: "aaa111" }) })
    useEnv({ REVIEW_DEBOUNCE_SECONDS: "0" })
    expect((await db().query("SELECT status FROM jobs")).rows[0].status).toBe("cancelled")
    expect((await reviewRow()).status).toBe("superseded")
  })
})
