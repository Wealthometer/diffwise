import pg from "pg"
import { config } from "../config.js"

pg.types.setTypeParser(20, (v) => Number(v)) // bigint → number (GitHub ids fit in 2^53)
pg.types.setTypeParser(1700, (v) => Number(v)) // numeric → number

let pool: pg.Pool | undefined

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config().DATABASE_URL, max: 15, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  return pool
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closeDb() {
  const p = pool
  pool = undefined
  await p?.end()
}
