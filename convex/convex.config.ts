import { defineApp } from 'convex/server'
import actionCache from '@convex-dev/action-cache/convex.config.js'
import rateLimiter from '@convex-dev/rate-limiter/convex.config.js'

const app = defineApp()

app.use(actionCache)
app.use(rateLimiter)

export default app
