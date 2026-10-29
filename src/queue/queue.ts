import type { PoolClient } from "pg"
import { db } from "../db/pool.js"

/**
 * A small, durable job queue on PostgreSQL.
 *
 * - Workers claim with FOR UPDATE SKIP LOCKED, so any number can run without double-processing.
 * - A claimed job holds a lease (locked_until). If its worker dies, the reaper puts it back.
 * - Failures retry with exponential backoff and jitter, then land in `failed` (dead letter).
 * - dedupe_key makes enqueueing idempotent (e.g. one review per PR head commit).
 * - group_key + supersede cancels stale queued work (a new push replaces the old one).
 * - Enqueueing can join the caller's transaction, so a job exists iff the data it refers to does.
 */

export const CHANNEL = "diffwise_jobs"

export type Job<P = unknown> = {
  id: number
  type: string
  payload: P
  attempts: number
  max_attempts: number
  group_key: string | null
}

export class NonRetryableError extends Error {
  override name = "NonRetryableError"
}

type Queryable = Pick<PoolClient, "query">

export async function enqueue(
  opts: { type: string; payload: unknown; dedupeKey?: string; groupKey?: string; supersede?: boolean; delaySeconds?: number; maxAttempts?: number },
  client: Queryable = db(),
): Promise<number | null> {
  if (opts.supersede && opts.groupKey) {
    await client.query("UPDATE jobs SET status = 'cancelled', updated_at = now(), finished_at = now() WHERE group_key = $1 AND status = 'queued'", [opts.groupKey])
  }
  const res = await client.query<{ id: number }>(
    `INSERT INTO jobs (type, payload, dedupe_key, group_key, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [opts.type, opts.payload, opts.dedupeKey ?? null, opts.groupKey ?? null, opts.delaySeconds ?? 0, opts.maxAttempts ?? 4],
  )
  await client.query(`SELECT pg_notify('${CHANNEL}', $1)`, [opts.type])
  return res.rows[0]?.id ?? null
}

export async function claim(workerId: string, limit: number, lockSeconds: number): Promise<Job[]> {
  const res = await db().query<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $1,
            locked_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, type, payload, attempts, max_attempts, group_key`,
    [workerId, limit, lockSeconds],
  )
  return res.rows
}

export async function complete(job: Job, workerId: string) {
  await db().query(
    "UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL, last_error = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND locked_by = $2",
    [job.id, workerId],
  )
}

/** 15s, 60s, 4m, 16m … capped at 1h, with ±20% jitter so retries don't stampede. */
export function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 15 * 4 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

export async function fail(job: Job, workerId: string, err: unknown): Promise<"retry" | "dead"> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
  const dead = err instanceof NonRetryableError || job.attempts >= job.max_attempts
  await db().query(
    `UPDATE jobs SET status = $3::job_status, last_error = $4, locked_by = NULL, locked_until = NULL, updated_at = now(),
            run_at = CASE WHEN $3::text = 'queued' THEN now() + make_interval(secs => $5) ELSE run_at END,
            finished_at = CASE WHEN $3::text = 'failed' THEN now() ELSE NULL END
      WHERE id = $1 AND locked_by = $2`,
    [job.id, workerId, dead ? "failed" : "queued", message, backoffSeconds(job.attempts)],
  )
  return dead ? "dead" : "retry"
}

/** Long jobs renew their lease so they aren't reaped while still working. */
export async function extendLease(job: Job, workerId: string, lockSeconds: number) {
  await db().query("UPDATE jobs SET locked_until = now() + make_interval(secs => $3) WHERE id = $1 AND locked_by = $2", [job.id, workerId, lockSeconds])
}

/** Returns jobs whose worker vanished (lease expired) to the queue, or dead-letters them. */
export async function reapExpired(): Promise<number> {
  const res = await db().query(
    `UPDATE jobs SET locked_by = NULL, locked_until = NULL, updated_at = now(),
            status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'queued'::job_status END,
            last_error = COALESCE(last_error, 'Worker stopped responding (lease expired)'),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() END
      WHERE status = 'running' AND locked_until < now()`,
  )
  return res.rowCount ?? 0
}

export async function queueStats() {
  const res = await db().query<{ status: string; n: number }>(
    "SELECT status::text, count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running') OR finished_at > now() - interval '24 hours' GROUP BY status",
  )
  return Object.fromEntries(res.rows.map((r) => [r.status, r.n])) as Record<string, number>
}
