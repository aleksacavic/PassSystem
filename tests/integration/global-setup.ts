import pg from 'pg'
import { stackEnv } from './env'

export default async function setup() {
  const env = stackEnv()
  const db = new pg.Client({ connectionString: env.dbUrl })
  await db.connect()
  // All test traffic comes from one IP; lift rate limits (individual tests lower them).
  await db.query(`update private.settings set value = 100000 where key like '%per_%'`)
  await db.query(`update private.settings set value = 0 where key = 'trust_cf_connecting_ip'`)
  await db.query(`delete from private.rate_limit_buckets`)
  await db.end()
  return async () => {
    const db2 = new pg.Client({ connectionString: env.dbUrl })
    await db2.connect()
    await db2.query(`update private.settings set value = d.v from (values
      ('register_per_ip_per_minute', 30), ('register_per_ip_per_hour', 400), ('register_per_event_per_minute', 600),
      ('pass_lookup_per_ip_per_minute', 120), ('public_event_per_ip_per_minute', 300), ('trust_cf_connecting_ip', 1)
    ) as d(k, v) where key = d.k`)
    await db2.end()
  }
}
