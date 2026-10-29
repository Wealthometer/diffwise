import { resetConfig } from "../src/config.js"
import { db } from "../src/db/pool.js"
import { migrate } from "../src/db/migrate.js"
import { clearTokenCache } from "../src/github/app-auth.js"
import { sign } from "../src/github/webhooks.js"
import { claim, complete, fail, type Job } from "../src/queue/queue.js"
import { runReview, type ReviewJob } from "../src/review/run-review.js"
import { buildApp } from "../src/web/app.js"

export async function resetDb() {
  await db().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
  await migrate(() => {})
}

export function useEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  resetConfig()
  clearTokenCache()
}

let deliveries = 0
/** Sends a correctly signed webhook through the real HTTP app. */
export async function webhook(app: Awaited<ReturnType<typeof buildApp>>, event: string, payload: unknown, opts: { secret?: string; delivery?: string } = {}) {
  const body = JSON.stringify(payload)
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? `d-${++deliveries}-${Date.now()}`,
      "x-hub-signature-256": sign(opts.secret ?? process.env.GITHUB_WEBHOOK_SECRET!, body),
    },
  })
  return { status: res.statusCode, body: res.json() }
}

/** Runs every due job once, like a worker would (minus the polling loop). */
export async function drain(workerId = "test-worker"): Promise<{ done: number; failed: string[] }> {
  let done = 0
  const failed: string[] = []
  for (;;) {
    await db().query("UPDATE jobs SET run_at = now() WHERE status = 'queued' AND run_at > now()") // skip debounce/backoff waits
    const jobs = await claim(workerId, 10, 60)
    if (!jobs.length) return { done, failed }
    for (const job of jobs) {
      try {
        await runReview(job as Job<ReviewJob>)
        await complete(job, workerId)
        done++
      } catch (err) {
        failed.push((err as Error).message)
        await fail(job, workerId, err)
      }
    }
  }
}

export const repo = { id: 555, full_name: "acme/shop", private: true }
export const installation = { id: 77, account: { login: "acme", type: "Organization" } }

export function prEvent(action: string, pr: { number: number; headSha: string; title?: string; draft?: boolean }) {
  return {
    action,
    installation,
    repository: repo,
    pull_request: { number: pr.number, title: pr.title ?? "Add checkout", draft: pr.draft ?? false, user: { login: "dev" }, head: { sha: pr.headSha } },
  }
}
