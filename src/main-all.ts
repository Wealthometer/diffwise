// Web server and queue worker in one process, for hosts that run a single service
// (e.g. Render's free plan). Elsewhere, prefer main-web and main-worker as separate processes.
import { config } from "./config.js"
import { closeDb } from "./db/pool.js"
import { logger, setService } from "./logger.js"
import type { Job } from "./queue/queue.js"
import { QueueWorker } from "./queue/worker.js"
import { runReview, type ReviewJob } from "./review/run-review.js"
import { buildApp } from "./web/app.js"

setService("all")
const cfg = config()
const app = await buildApp()
await app.listen({ host: cfg.HOST, port: cfg.PORT })
const worker = new QueueWorker({
  review: (job) => runReview(job as Job<ReviewJob>),
})
await worker.start()

let stopping = false
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) return
    stopping = true
    logger.info({ signal: sig, running: worker.running }, "shutting down: finishing in-flight reviews")
    setTimeout(() => process.exit(1), 30_000).unref()
    await app.close()
    await worker.stop(25_000)
    await closeDb()
    process.exit(0)
  })
}
