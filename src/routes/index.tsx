import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useAction } from 'convex/react'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { api } from '../../convex/_generated/api'
import type { HomeSearch } from '~/lib/homeSearch'
import { homeSearchDefaults, validateHomeSearch } from '~/lib/homeSearch'
import { registerSteamLookupSession } from '~/lib/registerSteamLookupSession'
import { getOrCreateSessionId } from '~/lib/sessionId'

const SESSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000

type SteamGameRow = {
  appid: number
  name: string
  estimatedSizeBytes: number
  estimatedSizeHuman: string
  isFreeToPlay: boolean
}

export const Route = createFileRoute('/')({
  validateSearch: validateHomeSearch,
  search: {
    middlewares: [stripSearchParams(homeSearchDefaults)],
  },
  head: () => ({
    meta: [
      {
        title: 'Steam Account Size',
      },
    ],
  }),
  component: Home,
})

function Home() {
  const search = Route.useSearch()
  const lookupAccount = useAction(api.steam.lookupAccount)
  const registerSession = useServerFn(registerSteamLookupSession)
  const { setAccount, setFilter, setHideFreeToPlay } = useHomeSearchState()
  const [sessionId, setSessionId] = useState('')
  const deferredSearch = useDeferredValue(search.filter)

  useEffect(() => {
    setSessionId(getOrCreateSessionId())
  }, [])

  const sessionQuery = useQuery({
    queryKey: ['steam-session', sessionId],
    enabled: sessionId.length > 0,
    retry: false,
    staleTime: SESSION_REFRESH_INTERVAL_MS,
    refetchInterval: SESSION_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      return registerSession({
        data: {
          sessionId,
        },
      })
    },
  })

  const lookupQuery = useQuery({
    queryKey: ['steam-account', search.account],
    enabled:
      search.account.trim().length > 0 &&
      sessionId.length > 0 &&
      sessionQuery.isSuccess,
    queryFn: async () => {
      return lookupAccount({
        account: search.account.trim(),
        sessionId,
      })
    },
  })

  const visibleBaseGames = useMemo(() => {
    const games: Array<SteamGameRow> = lookupQuery.data?.games ?? []
    if (!search.hideFreeToPlay) {
      return games
    }
    return games.filter((game) => !game.isFreeToPlay)
  }, [lookupQuery.data?.games, search.hideFreeToPlay])

  const filteredGames = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase()
    if (!query) {
      return visibleBaseGames
    }
    return visibleBaseGames.filter((game) =>
      game.name.toLowerCase().includes(query),
    )
  }, [deferredSearch, visibleBaseGames])

  const visibleTotalBytes = useMemo(() => {
    let total = 0
    for (const game of visibleBaseGames) {
      total += game.estimatedSizeBytes
    }
    return total
  }, [visibleBaseGames])

  const freeToPlayCount = useMemo(() => {
    const games: Array<SteamGameRow> = lookupQuery.data?.games ?? []
    return games.filter((game) => game.isFreeToPlay).length
  }, [lookupQuery.data?.games])

  const summaryText = useMemo(() => {
    if (!lookupQuery.data) {
      return null
    }

    const parts = [
      `${formatBytes(visibleTotalBytes)} total`,
      `${visibleBaseGames.length.toLocaleString()} games`,
    ]

    if (search.hideFreeToPlay && freeToPlayCount > 0) {
      parts.push(`${freeToPlayCount.toLocaleString()} free-to-play hidden`)
    }

    if (lookupQuery.data.missingGames > 0) {
      parts.push(
        `${lookupQuery.data.missingGames.toLocaleString()} missing estimates`,
      )
    }

    return parts.join('  /  ')
  }, [
    freeToPlayCount,
    lookupQuery.data,
    search.hideFreeToPlay,
    visibleBaseGames.length,
    visibleTotalBytes,
  ])

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Steam Account Size</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Public Steam profile URL, SteamID64, or vanity name. Windows install
        sizes only.
      </p>

      <form
        className="mt-6 flex flex-col gap-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const nextAccount = String(formData.get('account') ?? '').trim()

          if (nextAccount === search.account.trim()) {
            if (nextAccount) {
              void lookupQuery.refetch()
            }
            return
          }

          void setAccount(nextAccount)
        }}
      >
        <label className="sr-only" htmlFor="steam-account">
          Steam account
        </label>
        <input
          key={search.account}
          id="steam-account"
          name="account"
          defaultValue={search.account}
          placeholder="https://steamcommunity.com/id/yourname/"
          className="h-11 flex-1 border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-900"
        />
        <button
          type="submit"
          disabled={
            lookupQuery.isFetching ||
            sessionId.length === 0 ||
            sessionQuery.isPending ||
            sessionQuery.isError
          }
          className="h-11 border border-neutral-900 px-4 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {lookupQuery.isFetching ? 'Loading…' : 'Lookup'}
        </button>
      </form>

      {sessionQuery.error ? (
        <p className="mt-4 text-sm text-red-700">{sessionQuery.error.message}</p>
      ) : null}

      {lookupQuery.error ? (
        <p className="mt-4 text-sm text-red-700">
          {lookupQuery.error.message}
        </p>
      ) : null}

      {summaryText ? (
        <p className="mt-6 text-sm text-neutral-700">{summaryText}</p>
      ) : null}

      {lookupQuery.data ? (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={search.hideFreeToPlay}
              onChange={(event) => {
                void setHideFreeToPlay(event.target.checked)
              }}
              className="h-4 w-4"
            />
            Hide free-to-play
          </label>
          <input
            value={search.filter}
            onChange={(event) => {
              void setFilter(event.target.value)
            }}
            placeholder="Filter games"
            className="h-10 border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-900 sm:w-64"
          />
        </div>
      ) : null}

      <section className="mt-6">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-300">
              <th className="py-2 font-medium">Game</th>
              <th className="py-2 text-right font-medium">Install size</th>
            </tr>
          </thead>
          <tbody>
            {filteredGames.length > 0 ? (
              filteredGames.map((game) => (
                <tr key={game.appid} className="border-b border-neutral-200">
                  <td className="py-2 pr-4 text-neutral-950">{game.name}</td>
                  <td className="py-2 text-right font-mono text-neutral-950">
                    {game.estimatedSizeHuman}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={2} className="py-8 text-center text-neutral-500">
                  {lookupQuery.data
                    ? 'No games match the current filters.'
                    : 'Run a lookup to load games.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  )
}

function useHomeSearchState() {
  const navigate = Route.useNavigate()

  const updateSearch = (
    updater: (prev: HomeSearch) => HomeSearch,
    opts?: { replace?: boolean },
  ) => {
    return navigate({
      to: '/',
      search: updater,
      replace: opts?.replace,
    })
  }

  return {
    setAccount: (account: string) =>
      updateSearch((prev) => ({ ...prev, account })),
    setFilter: (filter: string) =>
      updateSearch((prev) => ({ ...prev, filter }), { replace: true }),
    setHideFreeToPlay: (hideFreeToPlay: boolean) =>
      updateSearch((prev) => ({ ...prev, hideFreeToPlay }), { replace: true }),
  }
}

function formatBytes(numBytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = numBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`
}
