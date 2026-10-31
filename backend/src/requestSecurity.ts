const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_LOCAL_ORIGINS = new Set([
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])

/** Restricts browser-originated mutations to the local dashboard and this local API. */
export function isAllowedMutationOrigin(origin: string | undefined, frontendUrl?: string): boolean {
  if (origin === undefined) return true // Non-browser local clients do not send Origin.
  if (!origin || origin === 'null') return false

  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false
  }
  if (parsedOrigin.origin !== origin || !LOOPBACK_HOSTS.has(parsedOrigin.hostname)) return false

  const trustedOrigins = new Set(DEFAULT_LOCAL_ORIGINS)
  if (frontendUrl) {
    try {
      const configured = new URL(frontendUrl)
      if (LOOPBACK_HOSTS.has(configured.hostname) && ['http:', 'https:'].includes(configured.protocol)) {
        trustedOrigins.add(configured.origin)
      }
    } catch {
      // An invalid optional frontend URL adds no trusted origin.
    }
  }
  return trustedOrigins.has(origin)
}
