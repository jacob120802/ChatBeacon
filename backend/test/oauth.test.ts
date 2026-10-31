import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createOAuthRoutes, OAuthStateStore, TWITCH_CHAT_READ_SCOPE, TWITCH_CHAT_SCOPES, TWITCH_CHAT_WRITE_SCOPE } from '../src/oauth.ts'

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3001/auth/twitch/callback',
}

type RouteDependencies = Parameters<typeof createOAuthRoutes>[0]

async function startTestServer(overrides: Partial<RouteDependencies> = {}) {
  let generatedState = 0
  const stateStore = overrides.stateStore ?? new OAuthStateStore(
    undefined,
    undefined,
    () => `test-state-${++generatedState}`,
  )
  const routes = createOAuthRoutes({
    getConfig: overrides.getConfig ?? (() => config),
    onAuthorized: overrides.onAuthorized,
    frontendUrl: overrides.frontendUrl,
    fetchImpl: overrides.fetchImpl ?? (async () => {
      throw new Error('Unexpected network request in offline test')
    }),
    stateStore,
  })

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/auth/twitch/login') {
      routes.login(response)
      return
    }
    if (request.method === 'GET' && url.pathname === '/auth/twitch/callback') {
      void routes.callback(request, response, url)
      return
    }
    response.writeHead(404).end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not receive a TCP address')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    stateStore,
    routes,
  }
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

async function callbackRequest(
  origin: string,
  values: Record<string, string> = {},
  cookieState?: string,
): Promise<Response> {
  const url = new URL('/auth/twitch/callback', origin)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  const headers = cookieState ? { cookie: `chatbeacon_oauth_state=${cookieState}` } : undefined
  return fetch(url, { headers, redirect: 'manual' })
}

function resultFrom(response: Response): string | null {
  const location = response.headers.get('location')
  return location ? new URL(location).searchParams.get('twitch') : null
}

test('OAuth state is random, expires, and can only be consumed once', () => {
  const states = new OAuthStateStore()
  const first = states.issue()
  const second = states.issue()

  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first, second)
  assert.equal(states.consume(first), true)
  assert.equal(states.consume(first), false)
})

test('logout cancels previously issued OAuth consent states before token exchange', async () => {
  const { origin, server, stateStore, routes } = await startTestServer()
  try {
    const state = stateStore.issue()
    routes.cancelPending()
    const response = await callbackRequest(origin, { state, code: 'fixture-code' }, state)
    assert.equal(resultFrom(response), 'error')
  } finally { await closeTestServer(server) }
})

test('OAuth state is rejected after its expiry', () => {
  let now = 100
  const states = new OAuthStateStore(25, () => now, () => 'expires-soon')
  const state = states.issue()

  now = 125
  assert.equal(states.consume(state), false)
})

test('login redirects with chat-reading and chat-writing scopes and a protected state cookie', async (t) => {
  const app = await startTestServer()
  t.after(() => closeTestServer(app.server))

  const response = await fetch(`${app.origin}/auth/twitch/login`, { redirect: 'manual' })
  const destination = new URL(response.headers.get('location') ?? '')
  const cookie = response.headers.get('set-cookie') ?? ''

  assert.equal(response.status, 302)
  assert.equal(destination.origin, 'https://id.twitch.tv')
  assert.equal(destination.pathname, '/oauth2/authorize')
  assert.equal(destination.searchParams.get('response_type'), 'code')
  assert.equal(destination.searchParams.get('client_id'), config.clientId)
  assert.equal(destination.searchParams.get('redirect_uri'), config.redirectUri)
  assert.deepEqual(destination.searchParams.getAll('scope'), [TWITCH_CHAT_SCOPES.join(' ')])
  assert.deepEqual(TWITCH_CHAT_SCOPES, [TWITCH_CHAT_READ_SCOPE, TWITCH_CHAT_WRITE_SCOPE])
  assert.equal(destination.searchParams.get('state'), 'test-state-1')
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Lax/i)
  assert.match(cookie, /Path=\/auth\/twitch/i)
})

test('login shows a safe configuration message without exposing thrown details', async (t) => {
  const privateDetail = 'do-not-display-this-secret'
  const app = await startTestServer({ getConfig: () => { throw new Error(privateDetail) } })
  t.after(() => closeTestServer(app.server))

  const response = await fetch(`${app.origin}/auth/twitch/login`)
  const page = await response.text()

  assert.equal(response.status, 503)
  assert.match(page, /Twitch login is not configured/)
  assert.doesNotMatch(page, new RegExp(privateDetail))
})

test('callback rejects missing and mismatched state without contacting Twitch', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'expected-state')
  const app = await startTestServer({ stateStore: states })
  t.after(() => closeTestServer(app.server))
  states.issue()

  const missing = await callbackRequest(app.origin, { code: 'private-code' }, 'expected-state')
  const mismatch = await callbackRequest(app.origin, { code: 'private-code', state: 'wrong-state' }, 'expected-state')

  assert.equal(missing.status, 303)
  assert.equal(mismatch.status, 303)
  assert.equal(resultFrom(mismatch), 'error')
})

test('callback rejects expired state', async (t) => {
  let now = 500
  const states = new OAuthStateStore(10, () => now, () => 'expired-state')
  const app = await startTestServer({ stateStore: states })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()
  now = 510

  const response = await callbackRequest(app.origin, { code: 'private-code', state }, state)

  assert.equal(response.status, 303)
  assert.equal(resultFrom(response), 'error')
})

test('Twitch denial is handled safely and its state cannot be reused', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'one-use-state')
  const app = await startTestServer({ stateStore: states })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()
  const values = { error: 'access_denied', error_description: 'private-provider-detail', state }

  const first = await callbackRequest(app.origin, values, state)
  const replay = await callbackRequest(app.origin, values, state)

  assert.equal(first.status, 303)
  assert.equal(resultFrom(first), 'cancelled')
  assert.doesNotMatch(first.headers.get('location') ?? '', /private-provider-detail|access_denied/)
  assert.equal(replay.status, 303)
  assert.equal(resultFrom(replay), 'error')
})

test('token exchange failure does not reveal the code, secret, or Twitch response', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'exchange-state')
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ error: 'private-token-response', token: 'private-token-value' }),
    { status: 400 },
  )
  const app = await startTestServer({ stateStore: states, fetchImpl })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()

  const response = await callbackRequest(app.origin, { code: 'private-auth-code', state }, state)
  const location = response.headers.get('location') ?? ''

  assert.equal(response.status, 303)
  assert.equal(resultFrom(response), 'error')
  assert.doesNotMatch(location, /private-auth-code|test-client-secret|private-token-response|private-token-value/)
})

test('token validation failure does not expose either token or raw response data', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'validation-state')
  let call = 0
  const fetchImpl: typeof fetch = async () => {
    call += 1
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: 'private-access-token', refresh_token: 'private-refresh-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ message: 'private-validation-detail' }), { status: 401 })
  }
  const app = await startTestServer({ stateStore: states, fetchImpl })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()

  const response = await callbackRequest(app.origin, { code: 'private-auth-code', state }, state)
  const location = response.headers.get('location') ?? ''

  assert.equal(response.status, 303)
  assert.equal(resultFrom(response), 'error')
  assert.doesNotMatch(location, /private-access-token|private-refresh-token|private-validation-detail|private-auth-code/)
})

test('successful authorization validates the token and returns no credential data', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'success-state')
  const requests: { url: string; init?: RequestInit }[] = []
  let grantedScopes: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === 'https://id.twitch.tv/oauth2/token') {
      return new Response(JSON.stringify({ access_token: 'private-access-token', refresh_token: 'private-refresh-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ client_id: config.clientId, scopes: [...TWITCH_CHAT_SCOPES], expires_in: 3600 }), { status: 200 })
  }
  const app = await startTestServer({ stateStore: states, fetchImpl, onAuthorized: async (tokens) => { grantedScopes = tokens.scopes; return true } })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()

  const response = await callbackRequest(app.origin, { code: 'private-auth-code', state }, state)
  const location = response.headers.get('location') ?? ''
  const validationRequest = requests[1]

  assert.equal(response.status, 303)
  assert.equal(resultFrom(response), 'connected')
  assert.equal(location, 'http://localhost:5173/?twitch=connected')
  assert.doesNotMatch(location, /private-auth-code|private-access-token|private-refresh-token|test-client-secret/)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://id.twitch.tv/oauth2/token')
  assert.equal(requests[1].url, 'https://id.twitch.tv/oauth2/validate')
  assert.deepEqual(grantedScopes, [...TWITCH_CHAT_SCOPES])
  assert.equal(new Headers(validationRequest.init?.headers).get('authorization'), 'OAuth private-access-token')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
})

test('authorization without user:read:chat asks for reauthorization and does not start chat', async (t) => {
  const states = new OAuthStateStore(undefined, undefined, () => 'missing-chat-scope')
  let authorizationStarted = false
  let call = 0
  const fetchImpl: typeof fetch = async () => {
    call += 1
    if (call === 1) return new Response(JSON.stringify({ access_token: 'private-access-token', refresh_token: 'private-refresh-token' }), { status: 200 })
    return new Response(JSON.stringify({ client_id: config.clientId, scopes: [] }), { status: 200 })
  }
  const app = await startTestServer({ stateStore: states, fetchImpl, onAuthorized: async () => { authorizationStarted = true; return true } })
  t.after(() => closeTestServer(app.server))
  const state = states.issue()

  const response = await callbackRequest(app.origin, { code: 'private-code', state }, state)
  const location = response.headers.get('location') ?? ''

  assert.equal(response.status, 303)
  assert.equal(resultFrom(response), 'permission')
  assert.equal(authorizationStarted, false)
  assert.doesNotMatch(location, /private-access-token|private-refresh-token|private-code/)
})
