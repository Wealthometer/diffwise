import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { closeDb, db } from "../../src/db/pool.js"
import { backoffSeconds, claim, complete, enqueue, fail, NonRetryableError, reapExpired } from "../../src/queue/queue.js"
import { QueueWorker } from "../../src/queue/worker.js"
import { resetDb } from "../helpers.js"

beforeEach(resetDb)
afterAll(closeDb)

const status = async (id: number) => (await db().query("SELECT status, attempts, last_error FROM jobs WHERE id = $1", [id])).rows[0]

describe("postgres job queue", () => {
  it("never gives the same job to two workers", async () => {
    for (let i = 0; i < 40; i++) await enqueue({ type: "t", payload: { i } })
    const claims = await Promise.all(Array.from({ length: 6 }, (_, w) => claim(`w${w}`, 10, 60)))
    const ids = claims.flat().map((j) => j.id)
    expect(ids).toHaveLength(40)
    expect(new Set(ids).size).toBe(40)
  })

  it("is idempotent by dedupe key", async () => {
    const a = await enqueue({ type: "t", payload: {}, dedupeKey: "review:1" })
    const b = await enqueue({ type: "t", payload: {}, dedupeKey: "review:1" })
    expect(a).toBeTypeOf("number")
    expect(b).toBeNull()
  })

  it("supersedes older queued jobs in the same group", async () => {
    const old = (await enqueue({ type: "t", payload: { sha: "a" }, groupKey: "pr:1", supersede: true }))!
    const nu = (await enqueue({ type: "t", payload: { sha: "b" }, groupKey: "pr:1", supersede: true }))!
    expect((await status(old)).status).toBe("cancelled")
    expect((await status(nu)).status).toBe("queued")
  })

  it("respects delays", async () => {
    await enqueue({ type: "t", payload: {}, delaySeconds: 60 })
    expect(await claim("w", 10, 60)).toHaveLength(0)
  })

  it("retries with backoff, then dead-letters", async () => {
    const id = (await enqueue({ type: "t", payload: {}, maxAttempts: 2 }))!
    let [job] = await claim("w", 1, 60)
    expect(await fail(job!, "w", new Error("flaky"))).toBe("retry")
    const row = await db().query("SELECT status, run_at > now() AS later FROM jobs WHERE id = $1", [id])
    expect(row.rows[0]).toEqual({ status: "queued", later: true })

    await db().query("UPDATE jobs SET run_at = now() WHERE id = $1", [id])
    ;[job] = await claim("w", 1, 60)
    expect(job!.attempts).toBe(2)
    expect(await fail(job!, "w", new Error("still flaky"))).toBe("dead")
    expect(await status(id)).toMatchObject({ status: "failed", attempts: 2, last_error: "still flaky" })
  })

  it("dead-letters non-retryable errors immediately", async () => {
    const id = (await enqueue({ type: "t", payload: {} }))!
    const [job] = await claim("w", 1, 60)
    expect(await fail(job!, "w", new NonRetryableError("PR deleted"))).toBe("dead")
    expect((await status(id)).status).toBe("failed")
  })

  it("returns jobs from crashed workers to the queue", async () => {
    const id = (await enqueue({ type: "t", payload: {} }))!
    await claim("crashed", 1, 60)
    await db().query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [id])
    expect(await reapExpired()).toBe(1)
    expect(await status(id)).toMatchObject({ status: "queued", attempts: 1 })
  })

  it("ignores completion from a worker that lost its lease", async () => {
    const id = (await enqueue({ type: "t", payload: {} }))!
    const [job] = await claim("slow", 1, 60)
    await db().query("UPDATE jobs SET locked_by = 'someone-else' WHERE id = $1", [id])
    await complete(job!, "slow")
    expect((await status(id)).status).toBe("running")
  })

  it("backoff grows and is capped", () => {
    expect(backoffSeconds(1)).toBeLessThan(backoffSeconds(3))
    expect(backoffSeconds(20)).toBeLessThanOrEqual(3600 * 1.2)
  })

  it("a real worker picks jobs up immediately via LISTEN/NOTIFY and drains on stop", async () => {
    const seen: number[] = []
    const worker = new QueueWorker(
      { t: async (job) => { seen.push((job.payload as { n: number }).n); await new Promise((r) => setTimeout(r, 50)) } },
      { concurrency: 3, lockSeconds: 60, pollMs: 10_000 }, // long poll: only NOTIFY can wake it quickly
    )
    await worker.start()
    const started = Date.now()
    for (let n = 0; n < 5; n++) await enqueue({ type: "t", payload: { n } })
    while (seen.length < 5 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20))
    await worker.stop()
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4])
    expect(Date.now() - started).toBeLessThan(3000)
    const done = await db().query("SELECT count(*)::int n FROM jobs WHERE status = 'done'")
    expect(done.rows[0].n).toBe(5)
  })
})
