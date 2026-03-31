import { createServerFn } from '@tanstack/react-start'

export const lookupSteamAccount = createServerFn({ method: 'POST' })
  .inputValidator((data: { account: string }) => data)
  .handler(async (options) => {
    const account = options.data.account.trim()
    if (!account) {
      throw new Error('Enter a Steam profile URL, SteamID64, or vanity name.')
    }

    const request = (options as typeof options & { request: Request }).request
    const [{ checkRateLimit }, { lookupSteamAccountByInput }] =
      await Promise.all([
        import('@vercel/firewall'),
        import('~/lib/server/steamLookup'),
      ])

    const rateLimit = await checkRateLimit('steam-account-lookup', {
      request,
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { firewallHostForDevelopment: 'ignore-for-testing' as const }),
    })

    if (process.env.NODE_ENV === 'production' && rateLimit.error === 'not-found') {
      throw new Error(
        'Missing Vercel Firewall rate limit rule: steam-account-lookup.',
      )
    }

    if (rateLimit.rateLimited) {
      throw new Error('Too many lookups. Try again shortly.')
    }

    return lookupSteamAccountByInput(account)
  })
