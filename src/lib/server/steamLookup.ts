import { eq, sql } from 'drizzle-orm'
import type {
  SteamCmdApp,
  SteamCmdDepot,
  SteamLookupResult,
  SteamOwnedGame,
  SteamSizeGame,
} from '~/lib/server/steamTypes'
import { formatBytes } from '~/lib/formatBytes'
import { getDb } from '~/lib/server/db'
import {
  steamAccountResolutionCache,
  steamAccountResultCache,
  steamAppInfoCache,
  steamOwnedGamesCache,
} from '~/lib/server/db/schema'

const WINDOWS_PLATFORM = 'windows'
const DEFAULT_LANGUAGE = 'english'
const STEAM_API_BASE = 'https://api.steampowered.com'
const STEAMCMD_INFO_BASE = 'https://api.steamcmd.net/v1/info'

const ACCOUNT_RESOLUTION_TTL_MS = 1000 * 60 * 60 * 24 * 30
const OWNED_GAMES_TTL_MS = 1000 * 60 * 60 * 12
const APP_INFO_TTL_MS = 1000 * 60 * 60 * 24 * 7
const ACCOUNT_RESULT_TTL_MS = 1000 * 60 * 60 * 12

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

export async function lookupSteamAccountByInput(
  account: string,
): Promise<SteamLookupResult> {
  const normalizedAccount = account.trim()
  const steamId = await resolveAccountInput(normalizedAccount)
  const result = await computeAccountWindowsSizes(steamId)

  return {
    ...result,
    account: normalizedAccount,
  }
}

async function resolveAccountInput(account: string): Promise<string> {
  const parsed = parseAccountInput(account)
  if (parsed.kind === 'steamId') {
    return parsed.value
  }

  const cacheKey = `vanity:${parsed.value.toLowerCase()}`
  const db = getDb()
  const cachedRows = await db
    .select({
      steamId: steamAccountResolutionCache.steamId,
      updatedAt: steamAccountResolutionCache.updatedAt,
    })
    .from(steamAccountResolutionCache)
    .where(eq(steamAccountResolutionCache.cacheKey, cacheKey))
    .limit(1)
  const cached = cachedRows.at(0)

  if (cached !== undefined && !isExpired(cached.updatedAt, ACCOUNT_RESOLUTION_TTL_MS)) {
    return cached.steamId
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
    throw new Error(`Could not resolve Steam account: ${account}`)
  }

  await db
    .insert(steamAccountResolutionCache)
    .values({
      cacheKey,
      steamId,
    })
    .onConflictDoUpdate({
      target: steamAccountResolutionCache.cacheKey,
      set: {
        steamId,
        updatedAt: sql`NOW()`,
      },
    })

  return steamId
}

async function fetchOwnedGames(steamId: string): Promise<Array<SteamOwnedGame>> {
  const db = getDb()
  const cachedRows = await db
    .select({
      payload: steamOwnedGamesCache.payload,
      updatedAt: steamOwnedGamesCache.updatedAt,
    })
    .from(steamOwnedGamesCache)
    .where(eq(steamOwnedGamesCache.steamId, steamId))
    .limit(1)
  const cached = cachedRows.at(0)

  if (cached !== undefined && !isExpired(cached.updatedAt, OWNED_GAMES_TTL_MS)) {
    return cached.payload
  }

  const apiKey = getSteamApiKey()
  const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('steamid', steamId)
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

  const normalized = games.map((game) => ({
    appid: game.appid,
    name: game.name?.trim() || `App ${game.appid}`,
  }))

  await db
    .insert(steamOwnedGamesCache)
    .values({
      steamId,
      payload: normalized,
    })
    .onConflictDoUpdate({
      target: steamOwnedGamesCache.steamId,
      set: {
        payload: normalized,
        updatedAt: sql`NOW()`,
      },
    })

  return normalized
}

async function fetchAppInfo(appid: number): Promise<SteamCmdApp | null> {
  const db = getDb()
  const cachedRows = await db
    .select({
      payload: steamAppInfoCache.payload,
      updatedAt: steamAppInfoCache.updatedAt,
    })
    .from(steamAppInfoCache)
    .where(eq(steamAppInfoCache.appid, appid))
    .limit(1)
  const cached = cachedRows.at(0)

  if (cached !== undefined && !isExpired(cached.updatedAt, APP_INFO_TTL_MS)) {
    return cached.payload
  }

  const payload = await fetchJson<{
    data?: Record<string, SteamCmdApp | string>
    status?: string
  }>(`${STEAMCMD_INFO_BASE}/${appid}`)

  const data = payload.data?.[String(appid)]
  const value = !data || typeof data === 'string' ? null : data

  await db
    .insert(steamAppInfoCache)
    .values({
      appid,
      payload: value,
    })
    .onConflictDoUpdate({
      target: steamAppInfoCache.appid,
      set: {
        payload: value,
        updatedAt: sql`NOW()`,
      },
    })

  return value
}

async function computeAccountWindowsSizes(
  steamId: string,
): Promise<SteamLookupResult> {
  const db = getDb()
  const cachedRows = await db
    .select({
      payload: steamAccountResultCache.payload,
      updatedAt: steamAccountResultCache.updatedAt,
    })
    .from(steamAccountResultCache)
    .where(eq(steamAccountResultCache.steamId, steamId))
    .limit(1)
  const cached = cachedRows.at(0)

  if (cached !== undefined && !isExpired(cached.updatedAt, ACCOUNT_RESULT_TTL_MS)) {
    return {
      ...cached.payload,
      account: '',
    }
  }

  const ownedGames = await fetchOwnedGames(steamId)
  const appInfoMap = new Map<number, SteamCmdApp | null>()

  await mapWithConcurrency(ownedGames, 12, async (game) => {
    const info = await fetchAppInfo(game.appid)
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

    const size = await estimateWindowsSize(appInfoMap, ownedGame.appid)
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

  games.sort(
    (left, right) => right.estimatedSizeBytes - left.estimatedSizeBytes,
  )

  let totalSizeBytes = 0
  for (const depotSize of totalDepotSizes.values()) {
    totalSizeBytes += depotSize
  }

  const result: Omit<SteamLookupResult, 'account'> = {
    steamId,
    totalSizeBytes,
    totalSizeHuman: formatBytes(totalSizeBytes),
    countedGames: games.length,
    missingGames,
    platform: WINDOWS_PLATFORM,
    games,
  }

  await db
    .insert(steamAccountResultCache)
    .values({
      steamId,
      payload: result,
    })
    .onConflictDoUpdate({
      target: steamAccountResultCache.steamId,
      set: {
        payload: result,
        updatedAt: sql`NOW()`,
      },
    })

  return {
    ...result,
    account: '',
  }
}

async function estimateWindowsSize(
  appInfoMap: Map<number, SteamCmdApp | null>,
  appid: number,
) {
  const appInfo = await getAppInfo(appInfoMap, appid)
  const depots = numericDepots(appInfo)
  const perGameDepotIds = new Set<string>()
  const globalDepotSizes: Array<{ depotId: string; sizeBytes: number }> = []
  let perGameBytes = 0

  for (const [depotId, depot] of depots) {
    const resolvedDepot = await resolveDepot(appInfoMap, depotId, depot)
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

  const sourceInfo = await getAppInfo(appInfoMap, sourceApp)
  const sourceDepot = sourceInfo?.depots?.[depotId]
  return sourceDepot && typeof sourceDepot === 'object' ? sourceDepot : null
}

async function getAppInfo(
  appInfoMap: Map<number, SteamCmdApp | null>,
  appid: number,
) {
  if (!appInfoMap.has(appid)) {
    const info = await fetchAppInfo(appid)
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

  throw new Error('Enter a Steam community profile URL, SteamID64, or vanity name.')
}

function parseNumber(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  return Number(value)
}

function selectDepotSize(depot: SteamCmdDepot) {
  const fromMaxSize = parseNumber(depot.maxsize)
  if (fromMaxSize) {
    return fromMaxSize
  }

  let largestManifest = 0
  for (const manifest of Object.values(depot.manifests ?? {})) {
    if (!manifest || typeof manifest === 'string') {
      continue
    }
    const manifestSize = parseNumber(manifest.size)
    if (manifestSize && manifestSize > largestManifest) {
      largestManifest = manifestSize
    }
  }

  return largestManifest
}

function getSteamApiKey() {
  const apiKey = process.env.STEAM_API_KEY
  if (!apiKey) {
    throw new Error('Missing STEAM_API_KEY.')
  }
  return apiKey
}

function isExpired(updatedAt: Date, ttlMs: number) {
  return Date.now() - updatedAt.getTime() > ttlMs
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`)
  }

  return (await response.json()) as T
}

async function mapWithConcurrency<T>(
  items: Array<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0

  async function runWorker() {
    for (;;) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= items.length) {
        return
      }

      const item = items[currentIndex]
      if (item === undefined) {
        return
      }

      await worker(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker(),
    ),
  )
}
