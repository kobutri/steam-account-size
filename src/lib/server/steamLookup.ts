import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
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
  steamAccountResolutions,
  steamApps,
  steamOwnedGameSyncs,
  steamOwnedGames,
} from '~/lib/server/db/schema'

const WINDOWS_PLATFORM = 'windows'
const DEFAULT_LANGUAGE = 'english'
const STEAM_API_BASE = 'https://api.steampowered.com'
const STEAMCMD_INFO_BASE = 'https://api.steamcmd.net/v1/info'

const ACCOUNT_RESOLUTION_TTL_MS = 1000 * 60 * 60 * 24 * 30
const OWNED_GAMES_TTL_MS = 1000 * 60 * 60 * 12
const APP_INFO_TTL_MS = 1000 * 60 * 60 * 24 * 7

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

type SteamAppRecord = {
  appid: number
  name: string | null
  type: string | null
  isFreeToPlay: boolean
  windowsSizeBytes: number | null
  hasSize: boolean
}

export async function lookupSteamAccountByInput(
  account: string,
): Promise<SteamLookupResult> {
  const normalizedAccount = account.trim()
  const steamId = await resolveAccountInput(normalizedAccount)
  const ownedGames = await getOwnedGamesForAccount(steamId)
  const apps = await getSteamApps(ownedGames)

  const totalDepotSizes = new Map<number, number>()
  const games: Array<SteamSizeGame> = []
  let missingGames = 0

  for (const ownedGame of ownedGames) {
    const app = apps.get(ownedGame.appid)
    if (!app) {
      continue
    }
    if (!app.name) {
      missingGames += 1
      continue
    }
    if (!isRealGame(app.name, app.type)) {
      continue
    }

    const windowsSizeBytes = app.windowsSizeBytes ?? 0
    if (!app.hasSize || windowsSizeBytes <= 0) {
      missingGames += 1
      continue
    }

    totalDepotSizes.set(ownedGame.appid, windowsSizeBytes)
    games.push({
      appid: ownedGame.appid,
      name: app.name,
      estimatedSizeBytes: windowsSizeBytes,
      estimatedSizeHuman: formatBytes(windowsSizeBytes),
      isFreeToPlay: app.isFreeToPlay,
      type: app.type,
    })
  }

  games.sort(
    (left, right) => right.estimatedSizeBytes - left.estimatedSizeBytes,
  )

  let totalSizeBytes = 0
  for (const depotSize of totalDepotSizes.values()) {
    totalSizeBytes += depotSize
  }

  return {
    account: normalizedAccount,
    steamId,
    totalSizeBytes,
    totalSizeHuman: formatBytes(totalSizeBytes),
    countedGames: games.length,
    missingGames,
    platform: WINDOWS_PLATFORM,
    games,
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
      steamId: steamAccountResolutions.steamId,
      updatedAt: steamAccountResolutions.updatedAt,
    })
    .from(steamAccountResolutions)
    .where(eq(steamAccountResolutions.cacheKey, cacheKey))
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
    .insert(steamAccountResolutions)
    .values({
      cacheKey,
      steamId,
    })
    .onConflictDoUpdate({
      target: steamAccountResolutions.cacheKey,
      set: {
        steamId,
        updatedAt: sql`NOW()`,
      },
    })

  return steamId
}

async function getOwnedGamesForAccount(
  steamId: string,
): Promise<Array<SteamOwnedGame>> {
  const db = getDb()
  const syncRows = await db
    .select({
      updatedAt: steamOwnedGameSyncs.updatedAt,
    })
    .from(steamOwnedGameSyncs)
    .where(eq(steamOwnedGameSyncs.steamId, steamId))
    .limit(1)
  const sync = syncRows.at(0)

  if (sync === undefined || isExpired(sync.updatedAt, OWNED_GAMES_TTL_MS)) {
    return refreshOwnedGamesForAccount(steamId)
  }

    const rows = await db
    .select({
      appid: steamOwnedGames.appid,
    })
    .from(steamOwnedGames)
    .where(eq(steamOwnedGames.steamId, steamId))

  return rows
}

async function refreshOwnedGamesForAccount(
  steamId: string,
): Promise<Array<SteamOwnedGame>> {
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
  }))

  const db = getDb()
  const currentAppIds = normalized.map((game) => game.appid)

  if (currentAppIds.length > 0) {
    await db
      .delete(steamOwnedGames)
      .where(
        and(
          eq(steamOwnedGames.steamId, steamId),
          notInArray(steamOwnedGames.appid, currentAppIds),
        ),
      )
  } else {
    await db.delete(steamOwnedGames).where(eq(steamOwnedGames.steamId, steamId))
  }

  if (normalized.length > 0) {
    await db
      .insert(steamOwnedGames)
      .values(
        normalized.map((game) => ({
          steamId,
          appid: game.appid,
        })),
      )
      .onConflictDoNothing()
  }

  await db
    .insert(steamOwnedGameSyncs)
    .values({
      steamId,
    })
    .onConflictDoUpdate({
      target: steamOwnedGameSyncs.steamId,
      set: {
        updatedAt: sql`NOW()`,
      },
    })

  return normalized
}

async function getSteamApps(ownedGames: Array<SteamOwnedGame>) {
  const appIds = Array.from(new Set(ownedGames.map((game) => game.appid)))
  if (appIds.length === 0) {
    return new Map<number, SteamAppRecord>()
  }

  const db = getDb()
  const existingRows = await db
    .select({
      appid: steamApps.appid,
      name: steamApps.name,
      type: steamApps.type,
      isFreeToPlay: steamApps.isFreeToPlay,
      windowsSizeBytes: steamApps.windowsSizeBytes,
      hasSize: steamApps.hasSize,
      updatedAt: steamApps.updatedAt,
    })
    .from(steamApps)
    .where(inArray(steamApps.appid, appIds))

  const staleOrMissing = appIds.filter((appid) => {
    const row = existingRows.find((entry) => entry.appid === appid)
    return row === undefined || isExpired(row.updatedAt, APP_INFO_TTL_MS)
  })

  if (staleOrMissing.length > 0) {
    const refreshedRows = await refreshSteamApps(staleOrMissing)
    for (const refreshed of refreshedRows) {
      const existingIndex = existingRows.findIndex(
        (entry) => entry.appid === refreshed.appid,
      )
      if (existingIndex >= 0) {
        existingRows[existingIndex] = refreshed
      } else {
        existingRows.push(refreshed)
      }
    }
  }

  return new Map<number, SteamAppRecord>(
    existingRows.map((row) => [
      row.appid,
      {
        appid: row.appid,
        name: row.name,
        type: row.type,
        isFreeToPlay: row.isFreeToPlay,
        windowsSizeBytes: row.windowsSizeBytes,
        hasSize: row.hasSize,
      },
    ]),
  )
}

async function refreshSteamApps(
  appIds: Array<number>,
) {
  const appInfoMap = new Map<number, SteamCmdApp | null>()

  await mapWithConcurrency(appIds, 12, async (appid) => {
    const info = await fetchAppInfo(appid)
    appInfoMap.set(appid, info)
  })

  const rows = appIds.map((appid) => {
    const appInfo = appInfoMap.get(appid) ?? null
    const name = normalizeName(appInfo?.common?.name)
    const type = normalizeType(appInfo?.common?.type)
    const windowsSizeBytes = estimateWindowsSizeFromAppInfo(appInfo)

    return {
      appid,
      name,
      type,
      isFreeToPlay: isFreeToPlay(appInfo),
      windowsSizeBytes,
      hasSize: windowsSizeBytes > 0,
      updatedAt: new Date(),
    }
  })

  const db = getDb()
  await db
    .insert(steamApps)
    .values(
      rows.map((row) => ({
        appid: row.appid,
        name: row.name,
        type: row.type,
        isFreeToPlay: row.isFreeToPlay,
        windowsSizeBytes: row.windowsSizeBytes > 0 ? row.windowsSizeBytes : null,
        hasSize: row.hasSize,
      })),
    )
    .onConflictDoUpdate({
      target: steamApps.appid,
      set: {
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        isFreeToPlay: sql`excluded.is_free_to_play`,
        windowsSizeBytes: sql`excluded.windows_size_bytes`,
        hasSize: sql`excluded.has_size`,
        updatedAt: sql`NOW()`,
      },
    })

  const persistedRows = await db
    .select({
      appid: steamApps.appid,
      name: steamApps.name,
      type: steamApps.type,
      isFreeToPlay: steamApps.isFreeToPlay,
      windowsSizeBytes: steamApps.windowsSizeBytes,
      hasSize: steamApps.hasSize,
      updatedAt: steamApps.updatedAt,
    })
    .from(steamApps)
    .where(inArray(steamApps.appid, appIds))

  return persistedRows
}

async function fetchAppInfo(appid: number): Promise<SteamCmdApp | null> {
  const payload = await fetchJson<{
    data?: Record<string, SteamCmdApp | string>
    status?: string
  }>(`${STEAMCMD_INFO_BASE}/${appid}`)

  const data = payload.data?.[String(appid)]
  return !data || typeof data === 'string' ? null : data
}

function estimateWindowsSizeFromAppInfo(appInfo: SteamCmdApp | null) {
  const depots = numericDepots(appInfo)
  const perGameDepotIds = new Set<string>()
  let perGameBytes = 0

  for (const [depotId, depot] of depots) {
    if (!matchesPlatform(depot, WINDOWS_PLATFORM)) {
      continue
    }
    if (!matchesLanguage(depot, DEFAULT_LANGUAGE)) {
      continue
    }
    if (isOptionalDepot(depot)) {
      continue
    }

    const sizeBytes = selectDepotSize(depot)
    if (sizeBytes <= 0) {
      continue
    }

    if (!perGameDepotIds.has(depotId)) {
      perGameDepotIds.add(depotId)
      perGameBytes += sizeBytes
    }
  }

  return perGameBytes
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

function isRealGame(name: string, type: string | null) {
  const normalizedName = name.toLowerCase()

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

function normalizeType(type: string | undefined) {
  return type?.trim().toLowerCase() || null
}

function normalizeName(name: string | undefined) {
  const trimmed = name?.trim()
  return trimmed ? trimmed : null
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
