import { createVerify } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAppJwt } from "../../src/github/app-auth.js"
import { sign, verifySignature } from "../../src/github/webhooks.js"
import { AnthropicProvider, REPORT_TOOL } from "../../src/review/llm/anthropic.js"
import { LlmError } from "../../src/review/llm/provider.js"
import { seal, unseal } from "../../src/web/session.js"
import { FakeAnthropic } from "../fakes/anthropic.js"

describe("webhook signatures", () => {
  const body = JSON.stringify({ action: "opened" })
  it("accepts GitHub's HMAC and rejects anything else", () => {
    expect(verifySignature("s3cret", body, sign("s3cret", body))).toBe(true)
    expect(verifySignature("s3cret", body, sign("other", body))).toBe(false)
    expect(verifySignature("s3cret", body + " ", sign("s3cret", body))).toBe(false)
    expect(verifySignature("s3cret", body, undefined)).toBe(false)
    expect(verifySignature("s3cret", body, "sha1=abc")).toBe(false)
  })
})

describe("GitHub App JWT", () => {
  it("is RS256-signed with the app id as issuer and a short lifetime", () => {
    const now = 1_700_000_000
    const jwt = createAppJwt("4242", process.env.GITHUB_PRIVATE_KEY!, now)
    const [h, p, s] = jwt.split(".")
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" })
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: now - 60, exp: now + 540, iss: "4242" })
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(process.env.TEST_GITHUB_PUBLIC_KEY!, Buffer.from(s!, "base64url"))).toBe(true)
  })
})

describe("session cookies", () => {
  it("round-trips, and rejects tampering and expiry", () => {
    const v = seal("k".repeat(32), { id: 7 }, 60)
    expect(unseal<{ id: number }>("k".repeat(32), v)?.id).toBe(7)
    expect(unseal("x".repeat(32), v)).toBeNull()
    const [body, mac] = v.split(".")
    const forged = Buffer.from(JSON.stringify({ id: 1, exp: 9e9 })).toString("base64url")
    expect(unseal("k".repeat(32), `${forged}.${mac}`)).toBeNull()
    expect(unseal("k".repeat(32), seal("k".repeat(32), { id: 7 }, -1))).toBeNull()
    expect(body).toBeTruthy()
  })
})

describe("Anthropic provider", () => {
  const fake = new FakeAnthropic(() => [{ path: "a.ts", line: 1 }])
  beforeAll(() => fake.start())
  afterAll(() => fake.stop())
  const make = (key = "test-key") => new AnthropicProvider({ apiKey: key, model: "claude-test", baseUrl: fake.url, maxOutputTokens: 1000, timeoutMs: 5000, maxRetries: 2 })

  it("forces the report_findings tool and returns its input", async () => {
    const r = await make().review({ system: "sys", prompt: "diff" })
    expect(r.findings).toEqual([{ path: "a.ts", line: 1 }])
    expect(r.model).toBe("claude-test")
    expect(r.inputTokens).toBeGreaterThan(0)
    const req = fake.requests.at(-1)!
    expect(req.toolChoice).toEqual({ type: "tool", name: "report_findings" })
    expect((req.tools[0] as { name: string }).name).toBe(REPORT_TOOL.name)
  })

  it("retries overloads and rate limits, then succeeds", async () => {
    fake.failures = [529, 429]
    const r = await make().review({ system: "s", prompt: "p" })
    expect(r.findings).toHaveLength(1)
    expect(fake.failures).toEqual([])
  })

  it("does not retry client errors", async () => {
    const before = fake.requests.length
    const err = await make("wrong-key").review({ system: "s", prompt: "p" }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.retryable).toBe(false)
    expect(err.message).toMatch(/401/)
    expect(fake.requests.length).toBe(before)
  })

  it("gives up after its retry budget with a retryable error", async () => {
    fake.failures = [529, 529, 529, 529]
    const err = await make().review({ system: "s", prompt: "p" }).catch((e) => e)
    expect(err.retryable).toBe(true)
    fake.failures = []
  })
})
