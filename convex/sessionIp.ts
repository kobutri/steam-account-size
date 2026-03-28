import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'

const SESSION_RETENTION_MS = 60 * 60 * 1000
const CLEANUP_BATCH_SIZE = 100

export const upsertSessionIp = internalMutation({
  args: {
    ipAddress: v.string(),
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sessionId = args.sessionId.trim()
    const ipAddress = args.ipAddress.trim()
    if (!sessionId) {
      throw new Error('Missing session id.')
    }
    if (!ipAddress) {
      throw new Error('Missing IP address.')
    }

    const existing = await ctx.db
      .query('steamLookupSessions')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .unique()

    const updatedAt = Date.now()
    if (existing) {
      await ctx.db.patch('steamLookupSessions', existing._id, {
        ipAddress,
        updatedAt,
      })
      return null
    }

    await ctx.db.insert('steamLookupSessions', {
      ipAddress,
      sessionId,
      updatedAt,
    })
    return null
  },
})

export const getIpAddressForSession = internalQuery({
  args: {
    sessionId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ipAddress: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = args.sessionId.trim()
    if (!sessionId) {
      return null
    }

    const session = await ctx.db
      .query('steamLookupSessions')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .unique()

    if (!session) {
      return null
    }

    return {
      ipAddress: session.ipAddress,
    }
  },
})

export const cleanupExpiredSessions = internalMutation({
  args: {
    cutoffTime: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const expiredSessions = await ctx.db
      .query('steamLookupSessions')
      .withIndex('by_updatedAt', (q) => q.lt('updatedAt', args.cutoffTime))
      .take(CLEANUP_BATCH_SIZE)

    for (const session of expiredSessions) {
      await ctx.db.delete('steamLookupSessions', session._id)
    }

    if (expiredSessions.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.sessionIp.cleanupExpiredSessions, {
        cutoffTime: args.cutoffTime,
      })
    }

    return expiredSessions.length
  },
})

export const cleanupExpiredSessionsFromNow = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoffTime = Date.now() - SESSION_RETENTION_MS
    const deletedCount: number = await ctx.runMutation(
      internal.sessionIp.cleanupExpiredSessions,
      {
        cutoffTime,
      },
    )
    return deletedCount
  },
})
