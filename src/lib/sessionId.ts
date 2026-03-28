const STORAGE_KEY = 'steam-account-size-session-id'

export function getOrCreateSessionId() {
  const existing = window.localStorage.getItem(STORAGE_KEY)
  if (existing) {
    return existing
  }

  const next = window.crypto.randomUUID()

  window.localStorage.setItem(STORAGE_KEY, next)
  return next
}
