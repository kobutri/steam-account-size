export type SteamOwnedGame = {
  appid: number
}

export type SteamCmdDepot = {
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

export type SteamCmdApp = {
  common?: {
    name?: string
    type?: string
  }
  depots?: Record<string, SteamCmdDepot | string | null>
  extended?: {
    isfreeapp?: string
  }
}

export type SteamSizeGame = {
  appid: number
  name: string
  estimatedSizeBytes: number
  estimatedSizeHuman: string
  isFreeToPlay: boolean
  type: string | null
}

export type SteamLookupResult = {
  account: string
  steamId: string
  totalSizeBytes: number
  totalSizeHuman: string
  countedGames: number
  missingGames: number
  platform: 'windows'
  games: Array<SteamSizeGame>
}
