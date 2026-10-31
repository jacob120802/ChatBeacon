import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const TWITCH_CHAT_READ_SCOPE = 'user:read:chat'
export const TWITCH_CHAT_WRITE_SCOPE = 'user:write:chat'
export const TWITCH_CHAT_SCOPES = [TWITCH_CHAT_READ_SCOPE, TWITCH_CHAT_WRITE_SCOPE] as const
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const STATE_COOKIE = 'chatbeacon_oauth_state'
const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const DEFAULT_FRONTEND_URL = 'http://localhost:5173/'

type OAuthResult = 'connected' | 'cancelled' | 'permission' | 'error'

export type TwitchConfiguration = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

type StoredTokens = {
  accessToken: string
  refreshToken: string
  scopes: string[]
}

type OAuthRouteDependencies = {
  getConfig: () => TwitchConfiguration
  onAuthorized?: (tokens: StoredTokens) => Promise<boolean>
  frontendUrl?: string
  fetchImpl?: typeof fetch
  stateStore?: OAuthStateStore
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class OAuthStateStore {
  private readonly pending = new Map<string, number>()

  constructor(
    private readonly ttlMs = OAUTH_STATE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly generate: () => string = () => randomBytes(32).toString('base64url'),
  ) {}

  issue(): string {
    this.removeExpired()

    let state = this.generate()
    while (this.pending.has(state)) {
      state = this.generate()
    }

    this.pending.set(state, this.now() + this.ttlMs)
    return state
  }

  consume(state: string | null): boolean {
    if (!state) return false

    this.removeExpired()
    if (!this.pending.has(state)) return false

    this.pending.delete(state)
    return true
  }

  clear(): void { this.pending.clear() }

  private removeExpired(): void {
    const now = this.now()
    for (const [state, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(state)
    }
  }
}

function cookieForState(state: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${STATE_COOKIE}=${state}; Max-Age=${OAUTH_STATE_TTL_MS / 1000}; Path=/auth/twitch; HttpOnly; SameSite=Lax${secure}`
}

function clearedStateCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${STATE_COOKIE}=; Max-Age=0; Path=/auth/twitch; HttpOnly; SameSite=Lax${secure}`
}

function stateFromCookie(header: string | undefined): string | null {
  if (!header) return null

  const matches = header
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${STATE_COOKIE}=`))

  if (matches.length !== 1) return null
  const value = matches[0].slice(STATE_COOKIE.length + 1)
  return value || null
}

function sendPage(
  response: ServerResponse,
  status: number,
  heading: string,
  message: string,
  clearCookie = false,
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...(clearCookie ? { 'set-cookie': clearedStateCookie() } : {}),
  })
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading} · ChatBeacon</title></head><body><main><h1>${heading}</h1><p>${message}</p></main></body></html>`)
}

function readStateCookie(request: IncomingMessage): string | null {
  return stateFromCookie(request.headers.cookie)
}

function redirectToDashboard(response: ServerResponse, result: OAuthResult, frontendUrl?: string): void {
  let destination: URL
  try {
    destination = new URL(frontendUrl ?? DEFAULT_FRONTEND_URL)
    const localHost = destination.hostname === 'localhost' || destination.hostname === '127.0.0.1'
    if (!localHost || !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
      destination = new URL(DEFAULT_FRONTEND_URL)
    }
  } catch {
    destination = new URL(DEFAULT_FRONTEND_URL)
  }
  destination.pathname = '/'
  destination.search = ''
  destination.hash = ''
  destination.searchParams.set('twitch', result)

  response.writeHead(303, {
    location: destination.toString(),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': clearedStateCookie(),
  })
  response.end()
}

async function successfulJson(response: Response): Promise<unknown | null> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }

  try {
    return await response.json()
  } catch {
    return null
  }
}

export function createOAuthRoutes(dependencies: OAuthRouteDependencies) {
  const stateStore = dependencies.stateStore ?? new OAuthStateStore()
  const fetchImpl = dependencies.fetchImpl ?? fetch
  let authorizationGeneration = 0

  function readConfig(): TwitchConfiguration | null {
    try {
      return dependencies.getConfig()
    } catch {
      return null
    }
  }

  return {
    // Logout also cancels consent flows already open in another browser tab.
    cancelPending(): void {
      authorizationGeneration += 1
      stateStore.clear()
    },

    login(response: ServerResponse): void {
      const config = readConfig()
      if (!config) {
        sendPage(
          response,
          503,
          'Twitch login is not configured',
          'Check TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_REDIRECT_URI in backend/.env.',
        )
        return
      }

      const state = stateStore.issue()
      const authorizationUrl = new URL(AUTHORIZE_URL)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('client_id', config.clientId)
      authorizationUrl.searchParams.set('redirect_uri', config.redirectUri)
      authorizationUrl.searchParams.set('scope', TWITCH_CHAT_SCOPES.join(' '))
      authorizationUrl.searchParams.set('state', state)
      authorizationUrl.searchParams.set('force_verify', 'true')

      response.writeHead(302, {
        location: authorizationUrl.toString(),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': cookieForState(state),
      })
      response.end()
    },

    async callback(
      request: IncomingMessage,
      response: ServerResponse,
      callbackUrl: URL,
    ): Promise<void> {
      const generation = authorizationGeneration
      const stateValues = callbackUrl.searchParams.getAll('state')
      const state = stateValues.length === 1 ? stateValues[0] : null
      const knownState = stateStore.consume(state)
      const cookieState = readStateCookie(request)

      if (!knownState || !state || cookieState !== state) {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      if (callbackUrl.searchParams.has('error')) {
        redirectToDashboard(response, 'cancelled', dependencies.frontendUrl)
        return
      }

      const codes = callbackUrl.searchParams.getAll('code')
      const code = codes.length === 1 ? codes[0] : null
      if (!code) {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      const config = readConfig()
      if (!config) {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      let tokenResponse: Response
      try {
        tokenResponse = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.redirectUri,
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      const tokenData = await successfulJson(tokenResponse)
      if (
        generation !== authorizationGeneration ||
        !isJsonObject(tokenData) ||
        typeof tokenData.access_token !== 'string' ||
        tokenData.access_token.length === 0 ||
        typeof tokenData.refresh_token !== 'string' ||
        tokenData.refresh_token.length === 0
      ) {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      let validationResponse: Response
      try {
        validationResponse = await fetchImpl(VALIDATE_URL, {
          method: 'GET',
          headers: { authorization: `OAuth ${tokenData.access_token}` },
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      const validationData = await successfulJson(validationResponse)
      if (generation !== authorizationGeneration || !isJsonObject(validationData) || validationData.client_id !== config.clientId || !Array.isArray(validationData.scopes)) {
        redirectToDashboard(response, 'error', dependencies.frontendUrl)
        return
      }

      if (!validationData.scopes.includes(TWITCH_CHAT_READ_SCOPE)) {
        redirectToDashboard(response, 'permission', dependencies.frontendUrl)
        return
      }

      const tokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        scopes: validationData.scopes.filter((scope): scope is string => typeof scope === 'string'),
      }
      if (dependencies.onAuthorized) {
        let ready = false
        try { ready = await dependencies.onAuthorized(tokens) } catch { ready = false }
        if (!ready) {
          redirectToDashboard(response, 'error', dependencies.frontendUrl)
          return
        }
      }
      redirectToDashboard(response, 'connected', dependencies.frontendUrl)
    },
  }
}
