import { defineConfig, globalIgnores } from 'eslint/config'
import { tanstackConfig } from '@tanstack/eslint-config'

export default defineConfig([
  ...tanstackConfig,
  globalIgnores(['.venv/**', '.output/**', '.vercel/**', 'drizzle/**']),
])
