import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { closeDb, db } from "./pool.js"

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations")
const LOCK = 818_002

export async function migrate(log: (m: string) => void = console.log) {
  const client = await db().connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK])
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name))
    for (const file of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue
      await client.query("BEGIN")
      try {
        await client.query(await readFile(join(DIR, file), "utf8"))
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file])
        await client.query("COMMIT")
        log(`applied ${file}`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {})
    client.release()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  migrate()
    .then(closeDb)
    .catch(async (e) => {
      console.error(e)
      await closeDb()
      process.exit(1)
    })
}
