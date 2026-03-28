import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'cleanup expired steam lookup sessions',
  { minutes: 15 },
  internal.sessionIp.cleanupExpiredSessionsFromNow,
  {},
)

export default crons
