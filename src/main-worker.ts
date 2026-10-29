import { closeDb } from "./db/pool.js"
import { logger, setService } from "./logger.js"
import type { Job } from "./queue/queue.js"
import { QueueWorker } from "./queue/worker.js"
import { runReview, type ReviewJob } from "./review/run-review.js"

setService("worker")
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
    await worker.stop(25_000)
    await closeDb()
    logger.info("bye")
    process.exit(0)
  })
}
