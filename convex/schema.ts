import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  steamLookupSessions: defineTable({
    ipAddress: v.string(),
    sessionId: v.string(),
    updatedAt: v.number(),
  })
    .index('by_sessionId', ['sessionId'])
    .index('by_updatedAt', ['updatedAt']),
})
