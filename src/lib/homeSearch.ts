import { fallback, zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

export const homeSearchDefaults = {
  account: '',
  filter: '',
  hideFreeToPlay: false,
} as const

export const homeSearchSchema = z.object({
  account: fallback(z.string(), homeSearchDefaults.account).default(
    homeSearchDefaults.account,
  ),
  filter: fallback(z.string(), homeSearchDefaults.filter).default(
    homeSearchDefaults.filter,
  ),
  hideFreeToPlay: fallback(
    z.boolean(),
    homeSearchDefaults.hideFreeToPlay,
  ).default(homeSearchDefaults.hideFreeToPlay),
})

export type HomeSearch = z.infer<typeof homeSearchSchema>

export const validateHomeSearch = zodValidator(homeSearchSchema)
