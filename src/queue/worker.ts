import { hostname } from "node:os"
import { randomBytes } from "node:crypto"
import pg from "pg"
import { config } from "../config.js"
import { logger } from "../logger.js"
import { CHANNEL, claim, complete, extendLease, fail, reapExpired, type Job } from "./queue.js"

export type Handler = (job: Job, ctx: { heartbeat: () => Promise<void> }) => Promise<void>

/**
 * Runs jobs with bounded concurrency. Wakes instantly on LISTEN/NOTIFY and also polls, so a
 * dropped notification only costs a couple of seconds.
 */
export class QueueWorker {
  readonly id = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`
  private active = 0
  private stopping = false
  private timers: NodeJS.Timeout[] = []
  private listener: pg.Client | undefined
  private wake: (() => void) | undefined
  private idle: Promise<void> = Promise.resolve()
  private log = logger.child({ worker: this.id })

  constructor(
    private handlers: Record<string, Handler>,
    private opts = { concurrency: config().WORKER_CONCURRENCY, lockSeconds: config().JOB_LOCK_SECONDS, pollMs: 2000 },
  ) {}

  async start() {
    this.listener = new pg.Client({ connectionString: config().DATABASE_URL })
    await this.listener.connect()
    await this.listener.query(`LISTEN ${CHANNEL}`)
    this.listener.on("notification", () => this.wake?.())
    this.listener.on("error", (err) => this.log.error({ err: err.message }, "listen connection error"))

    this.timers.push(setInterval(() => void reapExpired().then((n) => n && this.log.warn({ n }, "re-queued jobs from dead workers")).catch(() => {}), 30_000))
    this.idle = this.loop()
    this.log.info({ concurrency: this.opts.concurrency }, "queue worker started")
  }

  private async loop() {
    while (!this.stopping) {
      const free = this.opts.concurrency - this.active
      let got = 0
      if (free > 0) {
        try {
          const jobs = await claim(this.id, free, this.opts.lockSeconds)
          got = jobs.length
          for (const job of jobs) void this.run(job)
        } catch (err) {
          this.log.error({ err: (err as Error).message }, "claim failed")
        }
      }
      if (got === 0 || this.active >= this.opts.concurrency) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.opts.pollMs)
          this.wake = () => {
            clearTimeout(t)
            resolve()
          }
        })
      }
    }
  }

  private async run(job: Job) {
    this.active++
    const started = Date.now()
    const handler = this.handlers[job.type]
    const lease = setInterval(() => void extendLease(job, this.id, this.opts.lockSeconds).catch(() => {}), (this.opts.lockSeconds * 1000) / 3)
    try {
      if (!handler) throw new Error(`No handler for job type "${job.type}"`)
      await handler(job, { heartbeat: () => extendLease(job, this.id, this.opts.lockSeconds) })
      await complete(job, this.id)
      this.log.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "job done")
    } catch (err) {
      const outcome = await fail(job, this.id, err).catch(() => "unknown")
      this.log[outcome === "dead" ? "error" : "warn"]({ jobId: job.id, type: job.type, attempt: job.attempts, outcome, err: (err as Error).message }, "job failed")
    } finally {
      clearInterval(lease)
      this.active--
      this.wake?.()
    }
  }

  /** Stops claiming, waits for running jobs (up to `graceMs`). */
  async stop(graceMs = 25_000) {
    this.stopping = true
    this.wake?.()
    this.timers.forEach(clearInterval)
    await this.idle
    const deadline = Date.now() + graceMs
    while (this.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    await this.listener?.end().catch(() => {})
  }

  get running() {
    return this.active
  }
}
