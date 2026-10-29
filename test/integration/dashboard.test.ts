import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { closeDb, db } from "../../src/db/pool.js"
import { buildApp } from "../../src/web/app.js"
import { FakeGitHub } from "../fakes/github.js"
import { drain, installation, prEvent, repo, resetDb, useEnv, webhook } from "../helpers.js"

const gh = new FakeGitHub(process.env.TEST_GITHUB_PUBLIC_KEY!)
let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  await gh.start()
  useEnv({ GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url, ANTHROPIC_API_KEY: undefined })
  app = await buildApp()
})
afterAll(async () => {
  await app.close()
  await gh.stop()
  await closeDb()
})
beforeEach(async () => {
  await resetDb()
  gh.addPr(repo.full_name, { number: 3, title: "Store tokens", headSha: "fff000", files: [{ filename: "src/auth.ts", patch: '@@ -1 +1,2 @@\n x\n+const apiKey = "sk_live_51HxYzAbCdEfGhIjKlMnOpQr"' }] })
  await webhook(app, "installation", { action: "created", installation, repositories: [repo] })
  await webhook(app, "pull_request", prEvent("opened", { number: 3, headSha: "fff000", title: "Store tokens" }))
  await drain()
})

/** Runs the OAuth dance against the fake GitHub and returns the session cookie. */
async function signIn(installations: number[]) {
  gh.oauth.installations = installations
  const start = await app.inject({ url: "/login" })
  expect(start.statusCode).toBe(302)
  const authorize = new URL(start.headers.location as string)
  expect(authorize.pathname).toBe("/login/oauth/authorize")
  const state = authorize.searchParams.get("state")!
  const stateCookie = String(start.headers["set-cookie"]).split(";")[0]
  const cb = await app.inject({ url: `/auth/callback?code=${gh.oauth.code}&state=${state}`, headers: { cookie: stateCookie } })
  expect(cb.statusCode).toBe(302)
  const setCookie = ([] as string[]).concat(cb.headers["set-cookie"] as string | string[])
  return setCookie.find((c) => c.startsWith("dw_session="))!.split(";")[0]!
}

describe("dashboard", () => {
  it("shows a landing page with an install link when signed out", async () => {
    const res = await app.inject({ url: "/" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("Code review that points at the line.")
    expect(res.body).toContain("/apps/diffwise/installations/new")
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'")
  })

  it("rejects an OAuth callback with a forged state", async () => {
    const res = await app.inject({ url: `/auth/callback?code=${gh.oauth.code}&state=forged`, headers: { cookie: "dw_oauth_state=real" } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain("Sign-in failed")
  })

  it("lists reviews for installations the user can access, with filtered findings explained", async () => {
    const cookie = await signIn([installation.id])
    const list = await app.inject({ url: "/", headers: { cookie } })
    expect(list.body).toContain("acme/shop#3")
    expect(list.body).toContain("Store tokens")

    const id = (await db().query("SELECT id FROM reviews")).rows[0].id
    const detail = await app.inject({ url: `/reviews/${id}`, headers: { cookie } })
    expect(detail.statusCode).toBe(200)
    expect(detail.body).toContain("Hard-coded secret (Stripe live secret key)")
    expect(detail.body).toContain("Posted inline")
    expect(detail.body).toContain("Rules only")

    const usage = await app.inject({ url: "/usage", headers: { cookie } })
    expect(usage.body).toContain("AI reviews")
  })

  it("hides other accounts' reviews", async () => {
    const cookie = await signIn([]) // a GitHub user with no access to the acme installation
    const list = await app.inject({ url: "/", headers: { cookie } })
    expect(list.body).not.toContain("acme/shop#3")
    expect(list.body).toContain("Install on GitHub")
    const id = (await db().query("SELECT id FROM reviews")).rows[0].id
    expect((await app.inject({ url: `/reviews/${id}`, headers: { cookie } })).statusCode).toBe(404)
  })

  it("escapes untrusted text from pull requests", async () => {
    await db().query("UPDATE reviews SET pr_title = '<script>alert(1)</script>'")
    const cookie = await signIn([installation.id])
    const body = (await app.inject({ url: "/", headers: { cookie } })).body
    expect(body).not.toContain("<script>alert(1)</script>")
    expect(body).toContain("&#60;script&#62;")
  })

  it("blocks cross-site form posts", async () => {
    const res = await app.inject({ method: "POST", url: "/anything", headers: { origin: "https://evil.example" }, payload: "a=1" })
    expect(res.statusCode).toBe(403)
  })

  it("reports readiness with queue stats", async () => {
    const res = await app.inject({ url: "/health/ready" })
    expect(res.json()).toMatchObject({ ok: true, jobs: { done: 1 } })
  })
})
