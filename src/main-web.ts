import { config } from "./config.js"
import { closeDb } from "./db/pool.js"
import { setService } from "./logger.js"
import { buildApp } from "./web/app.js"

setService("web")
const cfg = config()
const app = await buildApp()
await app.listen({ host: cfg.HOST, port: cfg.PORT })

let stopping = false
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) return
    stopping = true
    setTimeout(() => process.exit(1), 15_000).unref()
    await app.close()
    await closeDb()
    process.exit(0)
  })
}
