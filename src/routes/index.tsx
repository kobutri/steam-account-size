import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useAction } from 'convex/react'
import { createFileRoute } from '@tanstack/react-router'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/')({
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
  const lookupAccount = useAction(api.steam.lookupAccount)
  const [account, setAccount] = useState('')
  const [search, setSearch] = useState('')
  const [hideFreeToPlay, setHideFreeToPlay] = useState(false)
  const deferredSearch = useDeferredValue(search)

  const lookupMutation = useMutation({
    mutationFn: async (value: string) => {
      return lookupAccount({ account: value })
    },
  })

  const visibleBaseGames = useMemo(() => {
    const games = lookupMutation.data?.games ?? []
    if (!hideFreeToPlay) {
      return games
    }
    return games.filter((game) => !game.isFreeToPlay)
  }, [hideFreeToPlay, lookupMutation.data?.games])

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
    const games = lookupMutation.data?.games ?? []
    return games.filter((game) => game.isFreeToPlay).length
  }, [lookupMutation.data?.games])

  const summaryText = useMemo(() => {
    if (!lookupMutation.data) {
      return null
    }

    const parts = [
      `${formatBytes(visibleTotalBytes)} total`,
      `${visibleBaseGames.length.toLocaleString()} games`,
    ]

    if (hideFreeToPlay && freeToPlayCount > 0) {
      parts.push(`${freeToPlayCount.toLocaleString()} free-to-play hidden`)
    }

    if (lookupMutation.data.missingGames > 0) {
      parts.push(
        `${lookupMutation.data.missingGames.toLocaleString()} missing estimates`,
      )
    }

    return parts.join('  /  ')
  }, [
    freeToPlayCount,
    hideFreeToPlay,
    lookupMutation.data,
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
          if (!account.trim()) {
            return
          }
          lookupMutation.reset()
          void lookupMutation.mutateAsync(account.trim())
        }}
      >
        <label className="sr-only" htmlFor="steam-account">
          Steam account
        </label>
        <input
          id="steam-account"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder="https://steamcommunity.com/id/yourname/"
          className="h-11 flex-1 border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-900"
        />
        <button
          type="submit"
          disabled={lookupMutation.isPending || !account.trim()}
          className="h-11 border border-neutral-900 px-4 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {lookupMutation.isPending ? 'Loading…' : 'Lookup'}
        </button>
      </form>

      <div className="mt-4 flex flex-col gap-3 border-t border-neutral-200 pt-4 text-sm text-neutral-700 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={hideFreeToPlay}
            onChange={(event) => setHideFreeToPlay(event.target.checked)}
            className="h-4 w-4"
          />
          Hide free-to-play games
        </label>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter games"
          className="h-10 border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-900 sm:w-64"
        />
      </div>

      {lookupMutation.error ? (
        <p className="mt-4 text-sm text-red-700">
          {lookupMutation.error.message}
        </p>
      ) : null}

      {summaryText ? (
        <p className="mt-6 text-sm text-neutral-700">{summaryText}</p>
      ) : null}

      {lookupMutation.data ? (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={hideFreeToPlay}
              onChange={(event) => setHideFreeToPlay(event.target.checked)}
              className="h-4 w-4"
            />
            Hide free-to-play
          </label>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
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
                  {lookupMutation.data
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
