'use node'

import { ActionCache } from '@convex-dev/action-cache'
import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import { action, internalAction } from './_generated/server'
import type { ActionCtx } from './_generated/server'

const WINDOWS_PLATFORM = 'windows'
const DEFAULT_LANGUAGE = 'english'
const STEAM_API_BASE = 'https://api.steampowered.com'
const STEAMCMD_INFO_BASE = 'https://api.steamcmd.net/v1/info'

const EXCLUDED_EXACT_NAMES = new Set([
  '3DMark',
  '3DMark Demo',
  'App 459960',
  'Blender',
  'Godot Engine',
  'Steam Client',
  'Steam Game Notes',
  'Steam Input Configs',
  'Steam Screenshots',
  'SteamVR',
])

const EXCLUDED_NAME_TOKENS = [' demo', ' free trial']
const EXCLUDED_TYPES = new Set([
  'advertising',
  'application',
  'dlc',
  'tool',
  'video',
])

type SteamOwnedGame = {
  appid: number
  name: string
}

type SteamCmdDepot = {
  config?: {
    language?: string
    oslist?: string
  }
  depotfromapp?: string
  from_oslist?: string
  manifests?: Record<
    string,
    | string
    | {
        download?: string
        gid?: string
        size?: string
      }
  >
  maxsize?: string
  optional?: string
  to_oslist?: string
}

type SteamCmdApp = {
  common?: {
    name?: string
    type?: string
  }
  depots?: Record<string, SteamCmdDepot | string | null>
  extended?: {
    isfreeapp?: string
  }
}

type SteamSizeGame = {
  appid: number
  name: string
  estimatedSizeBytes: number
  estimatedSizeHuman: string
  isFreeToPlay: boolean
  type: string | null
}

type SteamLookupResult = {
  account: string
  steamId: string
  totalSizeBytes: number
  totalSizeHuman: string
  countedGames: number
  missingGames: number
  platform: 'windows'
  games: Array<SteamSizeGame>
}

const resolveAccountCache = new ActionCache(components.actionCache, {
  action: internal.steam.resolveAccountInput,
  name: 'steam-account-resolve-v1',
  ttl: 1000 * 60 * 60 * 24 * 30,
})

const ownedGamesCache = new ActionCache(components.actionCache, {
  action: internal.steam.fetchOwnedGames,
  name: 'steam-owned-games-v1',
  ttl: 1000 * 60 * 60 * 12,
})

const appInfoCache = new ActionCache(components.actionCache, {
  action: internal.steam.fetchAppInfo,
  name: 'steam-app-info-v1',
  ttl: 1000 * 60 * 60 * 24 * 7,
})

const accountResultCache = new ActionCache(components.actionCache, {
  action: internal.steam.computeAccountWindowsSizes,
  name: 'steam-account-windows-sizes-v3',
  ttl: 1000 * 60 * 60 * 12,
})

export const lookupAccount = action({
  args: {
    account: v.string(),
  },
  handler: async (ctx, args): Promise<SteamLookupResult> => {
    const steamId = await resolveAccountCache.fetch(ctx, {
      account: args.account,
    })

    const result = await accountResultCache.fetch(ctx, {
      steamId,
    })

    return {
      ...result,
      account: args.account.trim(),
    }
  },
})

export const resolveAccountInput = internalAction({
  args: {
    account: v.string(),
  },
  handler: async (_ctx, args): Promise<string> => {
    const parsed = parseAccountInput(args.account)
    if (parsed.kind === 'steamId') {
      return parsed.value
    }

    const apiKey = getSteamApiKey()
    const url = new URL(`${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/`)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('vanityurl', parsed.value)

    const payload = await fetchJson<{
      response?: { steamid?: string; success?: number }
    }>(url.toString())

    const steamId = payload.response?.steamid
    if (!steamId || payload.response?.success !== 1) {
      throw new Error(`Could not resolve Steam account: ${args.account}`)
    }

    return steamId
  },
})

export const fetchOwnedGames = internalAction({
  args: {
    steamId: v.string(),
  },
  handler: async (_ctx, args): Promise<Array<SteamOwnedGame>> => {
    const apiKey = getSteamApiKey()
    const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('steamid', args.steamId)
    url.searchParams.set('include_appinfo', 'true')
    url.searchParams.set('include_played_free_games', 'true')

    const payload = await fetchJson<{
      response?: {
        game_count?: number
        games?: Array<{ appid: number; name?: string }>
      }
    }>(url.toString())

    const games = payload.response?.games
    if (!games) {
      throw new Error(
        'Steam did not return owned games. Make sure the profile exists and its Game details privacy is public.',
      )
    }

    return games.map((game) => ({
      appid: game.appid,
      name: game.name?.trim() || `App ${game.appid}`,
    }))
  },
})

export const fetchAppInfo = internalAction({
  args: {
    appid: v.number(),
  },
  handler: async (_ctx, args): Promise<SteamCmdApp | null> => {
    const payload = await fetchJson<{
      data?: Record<string, SteamCmdApp | string>
      status?: string
    }>(`${STEAMCMD_INFO_BASE}/${args.appid}`)

    const data = payload.data?.[String(args.appid)]
    if (!data || typeof data === 'string') {
      return null
    }

    return data
  },
})

export const computeAccountWindowsSizes = internalAction({
  args: {
    steamId: v.string(),
  },
  handler: async (ctx, args): Promise<SteamLookupResult> => {
    const ownedGames = await ownedGamesCache.fetch(ctx, {
      steamId: args.steamId,
    })

    const appInfoMap = new Map<number, SteamCmdApp | null>()
    await mapWithConcurrency(ownedGames, 12, async (game) => {
      const info = await appInfoCache.fetch(ctx, { appid: game.appid })
      appInfoMap.set(game.appid, info)
    })

    const totalDepotSizes = new Map<string, number>()
    const games: Array<SteamSizeGame> = []
    let missingGames = 0

    for (const ownedGame of ownedGames) {
      const appInfo = appInfoMap.get(ownedGame.appid) ?? null
      if (!isRealGame(appInfo, ownedGame.name)) {
        continue
      }

      const size = await estimateWindowsSize(ctx, appInfoMap, ownedGame.appid)
      if (size.perGameBytes <= 0) {
        missingGames += 1
        continue
      }

      for (const depot of size.globalDepots) {
        if (!totalDepotSizes.has(depot.depotId)) {
          totalDepotSizes.set(depot.depotId, depot.sizeBytes)
        }
      }

      games.push({
        appid: ownedGame.appid,
        name: getDisplayName(appInfo, ownedGame.name),
        estimatedSizeBytes: size.perGameBytes,
        estimatedSizeHuman: formatBytes(size.perGameBytes),
        isFreeToPlay: isFreeToPlay(appInfo),
        type: normalizeType(appInfo?.common?.type),
      })
    }

    games.sort((left, right) => right.estimatedSizeBytes - left.estimatedSizeBytes)

    let totalSizeBytes = 0
    for (const depotSize of totalDepotSizes.values()) {
      totalSizeBytes += depotSize
    }

    return {
      account: '',
      steamId: args.steamId,
      totalSizeBytes,
      totalSizeHuman: formatBytes(totalSizeBytes),
      countedGames: games.length,
      missingGames,
      platform: WINDOWS_PLATFORM,
      games,
    }
  },
})

async function estimateWindowsSize(
  ctx: ActionCtx,
  appInfoMap: Map<number, SteamCmdApp | null>,
  appid: number,
) {
  const appInfo = await getAppInfo(ctx, appInfoMap, appid)
  const depots = numericDepots(appInfo)
  const perGameDepotIds = new Set<string>()
  const globalDepotSizes: Array<{ depotId: string; sizeBytes: number }> = []
  let perGameBytes = 0

  for (const [depotId, depot] of depots) {
    const resolvedDepot = await resolveDepot(ctx, appInfoMap, depotId, depot)
    if (!resolvedDepot) {
      continue
    }
    if (!matchesPlatform(resolvedDepot, WINDOWS_PLATFORM)) {
      continue
    }
    if (!matchesLanguage(resolvedDepot, DEFAULT_LANGUAGE)) {
      continue
    }
    if (isOptionalDepot(resolvedDepot)) {
      continue
    }

    const sizeBytes = selectDepotSize(resolvedDepot)
    if (sizeBytes <= 0) {
      continue
    }

    if (!perGameDepotIds.has(depotId)) {
      perGameDepotIds.add(depotId)
      perGameBytes += sizeBytes
    }
    globalDepotSizes.push({ depotId, sizeBytes })
  }

  return { perGameBytes, globalDepots: globalDepotSizes }
}

async function resolveDepot(
  ctx: ActionCtx,
  appInfoMap: Map<number, SteamCmdApp | null>,
  depotId: string,
  depot: SteamCmdDepot,
) {
  if (selectDepotSize(depot) > 0) {
    return depot
  }

  const sourceApp = parseNumber(depot.depotfromapp)
  if (!sourceApp) {
    return depot
  }

  const sourceInfo = await getAppInfo(ctx, appInfoMap, sourceApp)
  const sourceDepot = sourceInfo?.depots?.[depotId]
  return sourceDepot && typeof sourceDepot === 'object' ? sourceDepot : null
}

async function getAppInfo(
  ctx: ActionCtx,
  appInfoMap: Map<number, SteamCmdApp | null>,
  appid: number,
) {
  if (!appInfoMap.has(appid)) {
    const info = await appInfoCache.fetch(ctx, { appid })
    appInfoMap.set(appid, info)
  }
  return appInfoMap.get(appid) ?? null
}

function numericDepots(appInfo: SteamCmdApp | null) {
  if (!appInfo?.depots) {
    return [] as Array<[string, SteamCmdDepot]>
  }

  return Object.entries(appInfo.depots).filter(
    (entry): entry is [string, SteamCmdDepot] =>
      /^\d+$/.test(entry[0]) && !!entry[1] && typeof entry[1] === 'object',
  )
}

function isRealGame(appInfo: SteamCmdApp | null, fallbackName: string) {
  const name = getDisplayName(appInfo, fallbackName)
  const normalizedName = name.toLowerCase()
  const type = normalizeType(appInfo?.common?.type)

  if (EXCLUDED_EXACT_NAMES.has(name)) {
    return false
  }
  if (EXCLUDED_TYPES.has(type ?? '')) {
    return false
  }
  if (EXCLUDED_NAME_TOKENS.some((token) => normalizedName.includes(token))) {
    return false
  }

  return true
}

function isFreeToPlay(appInfo: SteamCmdApp | null) {
  return appInfo?.extended?.isfreeapp === '1'
}

function matchesPlatform(depot: SteamCmdDepot, platform: string) {
  const configPlatforms = splitList(depot.config?.oslist)
  if (configPlatforms.length > 0 && !configPlatforms.includes(platform)) {
    return false
  }

  const fromPlatforms = splitList(depot.from_oslist)
  if (fromPlatforms.length > 0 && !fromPlatforms.includes(platform)) {
    return false
  }

  const toPlatforms = splitList(depot.to_oslist)
  if (toPlatforms.length > 0 && !toPlatforms.includes(platform)) {
    return false
  }

  return true
}

function matchesLanguage(depot: SteamCmdDepot, language: string) {
  const languages = splitList(depot.config?.language)
  return languages.length === 0 || languages.includes(language)
}

function isOptionalDepot(depot: SteamCmdDepot) {
  return depot.optional === '1'
}

function splitList(value: string | undefined) {
  return value
    ? value
        .split(/[,\s;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : []
}

function getDisplayName(appInfo: SteamCmdApp | null, fallbackName: string) {
  return appInfo?.common?.name?.trim() || fallbackName
}

function normalizeType(type: string | undefined) {
  return type?.trim().toLowerCase() || null
}

function parseAccountInput(account: string) {
  const trimmed = account.trim()
  if (!trimmed) {
    throw new Error('Enter a Steam profile URL, SteamID64, or vanity name.')
  }

  if (/^\d+$/.test(trimmed)) {
    return { kind: 'steamId' as const, value: trimmed }
  }

  if (!trimmed.includes('://')) {
    return { kind: 'vanity' as const, value: trimmed.replace(/^\/+|\/+$/g, '') }
  }

  const url = new URL(trimmed)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'profiles' && parts[1] && /^\d+$/.test(parts[1])) {
    return { kind: 'steamId' as const, value: parts[1] }
  }
  if (parts[0] === 'id' && parts[1]) {
    return { kind: 'vanity' as const, value: parts[1] }
  }

  throw new Error(
    'Use a standard Steam profile URL, SteamID64, or vanity name.',
  )
}

function getSteamApiKey() {
  const apiKey =
    (
      globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> }
      }
    ).process?.env?.STEAM_API_KEY ?? null
  if (!apiKey) {
    throw new Error('STEAM_API_KEY is not configured in Convex.')
  }
  return apiKey
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Request failed (${response.status}): ${body}`)
  }
  return (await response.json()) as T
}

async function mapWithConcurrency<T>(
  values: Array<T>,
  concurrency: number,
  worker: (value: T) => Promise<void>,
) {
  const queue = [...values]
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (queue.length > 0) {
      const value = queue.shift()
      if (!value) {
        return
      }
      await worker(value)
    }
  })
  await Promise.all(runners)
}

function parseNumber(value: string | undefined) {
  if (!value) {
    return 0
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function selectDepotSize(depot: SteamCmdDepot) {
  const publicManifest = depot.manifests?.public
  if (publicManifest && typeof publicManifest === 'object') {
    const publicSize = parseNumber(publicManifest.size)
    if (publicSize > 0) {
      return publicSize
    }
  }

  if (depot.manifests) {
    for (const manifest of Object.values(depot.manifests)) {
      if (manifest && typeof manifest === 'object') {
        const manifestSize = parseNumber(manifest.size)
        if (manifestSize > 0) {
          return manifestSize
        }
      }
    }
  }

  return parseNumber(depot.maxsize)
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
