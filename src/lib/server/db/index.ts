import { drizzle } from 'drizzle-orm/neon-serverless'
import ws from 'ws'
import * as schema from './schema'

let db: ReturnType<typeof drizzle<typeof schema>> | undefined

export function getDb() {
  if (!db) {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      throw new Error('Missing DATABASE_URL.')
    }

    db = drizzle({
      connection: databaseUrl,
      ws: ws,
      schema,
    })
  }

  return db
}
