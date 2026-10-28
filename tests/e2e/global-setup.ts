import pg from 'pg'
import { stackEnv } from '../integration/env'

/** Start each E2E run with empty rate-limit counters (local stack only). */
export default async function setup() {
  const db = new pg.Client({ connectionString: stackEnv().dbUrl })
  await db.connect()
  try {
    await db.query('delete from private.rate_limit_buckets')
  } finally {
    await db.end()
  }
}
