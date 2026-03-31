import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

const updatedAt = timestamp('updated_at', {
  withTimezone: true,
  mode: 'date',
})
  .notNull()
  .defaultNow()

export const steamAccountResolutions = pgTable('steam_account_resolutions', {
  cacheKey: text('cache_key').primaryKey(),
  steamId: text('steam_id').notNull(),
  updatedAt,
})

export const steamOwnedGameSyncs = pgTable('steam_owned_game_syncs', {
  steamId: text('steam_id').primaryKey(),
  updatedAt,
})

export const steamOwnedGames = pgTable(
  'steam_owned_games',
  {
    steamId: text('steam_id').notNull(),
    appid: integer('appid').notNull(),
  },
  (table) => [primaryKey({ columns: [table.steamId, table.appid] })],
)

export const steamApps = pgTable('steam_apps', {
  appid: integer('appid').primaryKey(),
  name: text('name'),
  type: text('type'),
  isFreeToPlay: boolean('is_free_to_play').notNull().default(false),
  windowsSizeBytes: integer('windows_size_bytes'),
  hasSize: boolean('has_size').notNull().default(false),
  updatedAt,
})
