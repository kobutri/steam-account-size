import * as z from 'zod'

export const homeSearchDefaults = {
  account: '',
  filter: '',
  hideFreeToPlay: false,
} as const

export const homeSearchSchema = z.object({
  account: z.string().default(homeSearchDefaults.account),
  filter: z.string().default(homeSearchDefaults.filter),
  hideFreeToPlay: z.boolean().default(homeSearchDefaults.hideFreeToPlay),
})

export type HomeSearch = z.infer<typeof homeSearchSchema>
