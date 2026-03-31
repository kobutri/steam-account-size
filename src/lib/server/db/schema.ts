import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type {
  SteamCmdApp,
  SteamLookupResult,
  SteamOwnedGame,
  SteamSizeGame,
} from '~/lib/server/steamTypes'

const updatedAt = timestamp('updated_at', {
  withTimezone: true,
  mode: 'date',
})
  .notNull()
  .defaultNow()

export const steamAccountResolutionCache = pgTable(
  'steam_account_resolution_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    steamId: text('steam_id').notNull(),
    updatedAt,
  },
)

export const steamOwnedGamesCache = pgTable('steam_owned_games_cache', {
  steamId: text('steam_id').primaryKey(),
  payload: jsonb('payload').$type<Array<SteamOwnedGame>>().notNull(),
  updatedAt,
})

export const steamAppInfoCache = pgTable('steam_app_info_cache', {
  appid: integer('appid').primaryKey(),
  payload: jsonb('payload').$type<SteamCmdApp | null>(),
  updatedAt,
})

export const steamAccountResultCache = pgTable('steam_account_result_cache', {
  steamId: text('steam_id').primaryKey(),
  payload: jsonb('payload').$type<Omit<SteamLookupResult, 'account'>>().notNull(),
  updatedAt,
})

export type SteamGameCacheRow = SteamSizeGame
