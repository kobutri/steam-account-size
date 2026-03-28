import { createServerFn } from '@tanstack/react-start'
import type { ConvexHttpClient as ConvexHttpClientType } from 'convex/browser'

export const registerSteamLookupSession = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string }) => data)
  .handler(async ({ data }) => {
    const sessionId = data.sessionId.trim()
    if (!sessionId) {
      throw new Error('Missing session id.')
    }

    const [{ getRequestIP }, { ConvexHttpClient }, { internal }] =
      await Promise.all([
        import('@tanstack/react-start/server'),
        import('convex/browser'),
        import('../../convex/_generated/api'),
      ])

    const ip = getRequestIP({ xForwardedFor: true })
    if (!ip) {
      throw new Error('Could not determine client IP.')
    }

    const convexUrl =
      process.env.VITE_CONVEX_URL ?? import.meta.env.VITE_CONVEX_URL
    if (!convexUrl) {
      throw new Error('Missing Convex URL.')
    }

    const deployKey = process.env.CONVEX_DEPLOY_KEY
    if (!deployKey) {
      throw new Error(
        'Missing CONVEX_DEPLOY_KEY for session registration. Add it to the app runtime environment.',
      )
    }

    const client = new ConvexHttpClient(convexUrl) as ConvexHttpClientType & {
      setAdminAuth: (token: string) => void
      mutation: (
        mutation: typeof internal.sessionIp.upsertSessionIp,
        args: {
          ipAddress: string
          sessionId: string
        },
        options?: {
          skipQueue?: boolean
        },
      ) => Promise<null>
    }
    client.setAdminAuth(deployKey)

    await client.mutation(
      internal.sessionIp.upsertSessionIp,
      {
        ipAddress: ip,
        sessionId,
      },
      { skipQueue: true },
    )

    return { ok: true as const }
  })
