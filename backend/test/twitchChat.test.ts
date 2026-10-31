import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { TwitchChatService } from '../src/twitchChat.ts'
import type { RefreshTokenStorage } from '../src/tokenStore.ts'

class MemoryTokenStore implements RefreshTokenStorage {
  saves: string[] = []
  cleared = false
  loads = 0
  constructor(public value: string | null = null) {}
  async load(): Promise<string | null> { this.loads += 1; return this.value }
  async save(refreshToken: string): Promise<void> { this.value = refreshToken; this.saves.push(refreshToken) }
  async clear(): Promise<void> { this.value = null; this.cleared = true }
}

class FakeSocket extends EventEmitter {
  readyState = 0
  onOpen(listener: () => void): void { this.on('open', listener) }
  onMessage(listener: (data: Buffer) => void): void { this.on('message', listener) }
  onClose(listener: () => void): void { this.on('close', listener) }
  onError(listener: () => void): void { this.on('error', listener) }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)) }
  welcome(id: string): void { this.emit('message', Buffer.from(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, keepalive_timeout_seconds: 10 } } }))) }
}

test('local logout stops the socket, clears remembered authorization, and permits explicit sign-in again', async () => {
  const sockets: FakeSocket[] = []
  const store = new MemoryTokenStore()
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'fixture', redirectUri: 'http://localhost/callback' }),
    async (url) => String(url).endsWith('/users')
      ? new Response(JSON.stringify({ data: [{ id: 'channel' }] })) : new Response(null, { status: 202 }),
    () => { const socket = new FakeSocket(); sockets.push(socket); return socket }, store,
  )
  const first = service.authorize({ accessToken: 'fixture', refreshToken: 'fixture', scopes: ['user:write:chat'] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  sockets[0]!.welcome('fixture-session')
  assert.equal(await first, true)
  assert.equal(await service.logout(), true)
  assert.equal(store.value, null)
  assert.equal(sockets[0]!.readyState, 3)
  assert.equal(service.getStatus().authorization.state, 'signed_out')
  assert.equal(service.getAuthorizedUserId(), null)
  assert.equal(service.canSendChatMessages(), false)
  assert.equal(await service.restoreAuthorization(), false)
  assert.deepEqual(service.getMessages(), [])
  const second = service.authorize({ accessToken: 'fixture-new', refreshToken: 'fixture-new' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  sockets[1]!.welcome('fixture-new-session')
  assert.equal(await second, true)
  assert.equal(service.getStatus().authorization.state, 'signed_in')
  service.stop()
})

test('logout invalidates an in-flight token refresh and does not open a socket or retain a rotated token', async () => {
  let release!: (response: Response) => void
  let calls = 0
  const store = new MemoryTokenStore('fixture-refresh')
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'fixture', redirectUri: 'http://localhost/callback' }),
    async () => { calls += 1; return new Promise<Response>((resolve) => { release = resolve }) },
    () => { throw new Error('Socket must not open after logout') }, store,
  )
  const restoring = service.restoreAuthorization()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const logout = service.logout()
  release(new Response(JSON.stringify({ access_token: 'old-fixture', refresh_token: 'rotated-fixture' })))
  assert.equal(await restoring, false)
  assert.equal(await logout, true)
  assert.equal(store.value, null)
  assert.equal(calls, 1)
  assert.equal(service.getStatus().state, 'disconnected')
})

test('failed remembered-login removal reports error without leaving chat authorized', async () => {
  const store = new MemoryTokenStore('fixture')
  store.clear = async () => { throw new Error('Simulated disk failure') }
  const service = new TwitchChatService(() => ({ clientId: 'client', clientSecret: 'fixture', redirectUri: 'http://localhost/callback' }), undefined, undefined, store)
  assert.equal(await service.logout(), false)
  assert.equal(service.getAuthorizedUserId(), null)
  assert.equal(service.getStatus().authorization.state, 'error')
  assert.match(service.getStatus().authorization.message ?? '', /could not be removed/u)
  assert.equal(await service.restoreAuthorization(), false)
})

test('gets the authorized account ID from Helix and uses it for subscription', async () => {
  const socket = new FakeSocket()
  let requestedUrl = ''
  let requestHeaders: Headers | null = null
  const subscriptionBodies: Record<string, unknown>[] = []
  const tokenStore = new MemoryTokenStore()
  const service = new TwitchChatService(
    () => ({ clientId: 'private-client', clientSecret: 'unused-secret', redirectUri: 'http://localhost/callback' }),
    async (input, init) => {
      const url = String(input)
      if (url === 'https://api.twitch.tv/helix/users') {
        requestedUrl = url
        requestHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify({ data: [{ id: 'account-123' }] }), { status: 200 })
      }
      subscriptionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(null, { status: 202 })
    },
    () => socket,
    tokenStore,
  )

  const authorization = service.authorize({ accessToken: 'private-token', refreshToken: 'private-refresh' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('private-session')
  assert.equal(await authorization, true)
  assert.equal(requestedUrl, 'https://api.twitch.tv/helix/users')
  assert.equal(requestHeaders?.get('authorization'), 'Bearer private-token')
  assert.equal(requestHeaders?.get('client-id'), 'private-client')
  assert.deepEqual(subscriptionBodies.map((item) => item.type), ['channel.chat.message', 'stream.online', 'stream.offline'])
  assert.deepEqual(subscriptionBodies[0]?.condition, { broadcaster_user_id: 'account-123', user_id: 'account-123' })
  assert.deepEqual(tokenStore.saves, ['private-refresh'])
})

test('syncs an existing live stream on startup using Twitch stream ID and started_at', async () => {
  const socket = new FakeSocket()
  const seen: unknown[] = []
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback' }),
    async (input) => {
      const url = String(input)
      if (url === 'https://api.twitch.tv/helix/users') return new Response(JSON.stringify({ data: [{ id: 'account-123' }] }), { status: 200 })
      if (url.startsWith('https://api.twitch.tv/helix/streams?')) return new Response(JSON.stringify({ data: [{ id: 'stream-123', started_at: '2026-10-30T11:30:00Z' }] }), { status: 200 })
      return new Response(null, { status: 202 })
    },
    () => socket,
    new MemoryTokenStore(),
    undefined,
    async (event) => { seen.push(event) },
  )
  const authorization = service.authorize({ accessToken: 'access', refreshToken: 'refresh' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('eventsub-session')
  assert.equal(await authorization, true)
  assert.deepEqual(seen, [{ kind: 'snapshot', broadcasterId: 'account-123', streamId: 'stream-123', startedAt: '2026-10-30T11:30:00Z' }])
  service.stop()
})

test('sends chat messages only with chat-write permission and the authorized channel identity', async () => {
  const socket = new FakeSocket()
  const requests: { url: string; init?: RequestInit }[] = []
  const service = new TwitchChatService(
    () => ({ clientId: 'client-id', clientSecret: 'private-secret', redirectUri: 'http://localhost/callback' }),
    async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === 'https://api.twitch.tv/helix/users') return new Response(JSON.stringify({ data: [{ id: 'broadcaster-123' }] }), { status: 200 })
      if (url === 'https://api.twitch.tv/helix/chat/messages') return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 })
      return new Response(null, { status: 202 })
    },
    () => socket,
    new MemoryTokenStore(),
  )
  const authorization = service.authorize({ accessToken: 'private-access', refreshToken: 'private-refresh', scopes: ['user:read:chat', 'user:write:chat'] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('session')
  assert.equal(await authorization, true)
  assert.equal(service.canSendChatMessages(), true)
  assert.equal(await service.sendChatMessage('Poll: Which game?', 'viewer-message-1'), true)
  const sendRequest = requests.find((request) => request.url === 'https://api.twitch.tv/helix/chat/messages')
  assert.equal(new Headers(sendRequest?.init?.headers).get('authorization'), 'Bearer private-access')
  assert.deepEqual(JSON.parse(String(sendRequest?.init?.body)), {
    broadcaster_id: 'broadcaster-123', sender_id: 'broadcaster-123', message: 'Poll: Which game?', reply_parent_message_id: 'viewer-message-1',
  })
})

test('reactively refreshes an expired access token, rotates its refresh token, and restores EventSub before retrying chat', async () => {
  const sockets: FakeSocket[] = []
  const tokenStore = new MemoryTokenStore()
  const chatAuthorizationHeaders: string[] = []
  let subscriptionRequests = 0
  const service = new TwitchChatService(
    () => ({ clientId: 'client-id', clientSecret: 'private-secret', redirectUri: 'http://localhost/callback' }),
    async (input, init) => {
      const url = String(input)
      if (url === 'https://api.twitch.tv/helix/users') return new Response(JSON.stringify({ data: [{ id: 'account-123' }] }), { status: 200 })
      if (url === 'https://id.twitch.tv/oauth2/token') return new Response(JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh' }), { status: 200 })
      if (url === 'https://id.twitch.tv/oauth2/validate') return new Response(JSON.stringify({ client_id: 'client-id', scopes: ['user:read:chat', 'user:write:chat'] }), { status: 200 })
      if (url === 'https://api.twitch.tv/helix/eventsub/subscriptions') { subscriptionRequests += 1; return new Response(null, { status: 202 }) }
      if (url === 'https://api.twitch.tv/helix/chat/messages') {
        const authorization = new Headers(init?.headers).get('authorization') ?? ''
        chatAuthorizationHeaders.push(authorization)
        return authorization === 'Bearer expired-access'
          ? new Response(null, { status: 401 })
          : new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    },
    () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    tokenStore,
  )

  const initialAuthorization = service.authorize({ accessToken: 'expired-access', refreshToken: 'initial-refresh', scopes: ['user:read:chat', 'user:write:chat'] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  sockets[0]!.welcome('initial-session')
  assert.equal(await initialAuthorization, true)

  const sending = service.sendChatMessage('A safe test reply')
  for (let attempt = 0; attempt < 20 && sockets.length < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(sockets.length, 2)
  sockets[1]!.welcome('refreshed-session')

  assert.equal(await sending, true)
  assert.deepEqual(chatAuthorizationHeaders, ['Bearer expired-access', 'Bearer refreshed-access'])
  assert.deepEqual(tokenStore.saves, ['initial-refresh', 'rotated-refresh'])
  assert.equal(subscriptionRequests, 6)
  assert.equal(service.getStatus().state, 'connected')
  assert.doesNotMatch(JSON.stringify(service.getStatus()), /refreshed-session|refreshed-access|rotated-refresh/)
  service.stop()
})

test('keeps chat sending disabled for existing read-only grants', async () => {
  const socket = new FakeSocket()
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback' }),
    async (input) => String(input) === 'https://api.twitch.tv/helix/users'
      ? new Response(JSON.stringify({ data: [{ id: 'broadcaster' }] }), { status: 200 })
      : new Response(null, { status: 202 }),
    () => socket,
    new MemoryTokenStore(),
  )
  const authorization = service.authorize({ accessToken: 'read-token', refreshToken: 'refresh' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('session')
  assert.equal(await authorization, true)
  assert.equal(service.canSendChatMessages(), false)
  assert.equal(await service.sendChatMessage('should not send'), false)
})

test('Helix failures do not start EventSub or expose response details in status', async () => {
  let socketCreations = 0
  const tokenStore = new MemoryTokenStore()
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback' }),
    async () => new Response('private API error', { status: 401 }),
    () => { socketCreations += 1; throw new Error('should not connect') },
    tokenStore,
  )
  assert.equal(await service.authorize({ accessToken: 'token', refreshToken: 'refresh' }), false)
  for (let attempt = 0; attempt < 20 && !tokenStore.cleared; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(socketCreations, 0)
  assert.equal(service.getStatus().state, 'error')
  assert.equal(service.getStatus().subscription, 'error')
  assert.equal(tokenStore.cleared, true)
})

test('startup refreshes the saved grant, validates it, and subscribes on the new session', async () => {
  const socket = new FakeSocket()
  const tokenStore = new MemoryTokenStore('saved-refresh-token')
  const requests: { url: string; init?: RequestInit }[] = []
  const service = new TwitchChatService(
    () => ({ clientId: 'private-client', clientSecret: 'private-secret', redirectUri: 'http://localhost:3001/auth/twitch/callback' }),
    async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === 'https://id.twitch.tv/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token' }), { status: 200 })
      }
      if (url === 'https://id.twitch.tv/oauth2/validate') {
        return new Response(JSON.stringify({ client_id: 'private-client', scopes: ['user:read:chat'] }), { status: 200 })
      }
      if (url === 'https://api.twitch.tv/helix/users') {
        return new Response(JSON.stringify({ data: [{ id: 'account-123' }] }), { status: 200 })
      }
      return new Response(null, { status: 202 })
    },
    () => socket,
    tokenStore,
  )

  const restoration = service.restoreAuthorization()
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('fresh-session')

  assert.equal(await restoration, true)
  assert.deepEqual(tokenStore.saves, ['rotated-refresh-token'])
  assert.deepEqual(requests.map((request) => request.url), [
    'https://id.twitch.tv/oauth2/token',
    'https://id.twitch.tv/oauth2/validate',
    'https://api.twitch.tv/helix/users',
    'https://api.twitch.tv/helix/eventsub/subscriptions',
    'https://api.twitch.tv/helix/eventsub/subscriptions',
    'https://api.twitch.tv/helix/eventsub/subscriptions',
  ])
  const refreshBody = new URLSearchParams(String(requests[0].init?.body))
  assert.equal(refreshBody.get('grant_type'), 'refresh_token')
  assert.equal(refreshBody.get('refresh_token'), 'saved-refresh-token')
  assert.equal(new Headers(requests[1].init?.headers).get('authorization'), 'OAuth refreshed-access-token')
  assert.deepEqual(JSON.parse(String(requests[3].init?.body)), {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: 'account-123', user_id: 'account-123' },
    transport: { method: 'websocket', session_id: 'fresh-session' },
  })
  assert.equal(service.getStatus().subscription, 'enabled')
  assert.doesNotMatch(JSON.stringify(service.getStatus()), /fresh-session|refreshed-access-token|rotated-refresh-token/)
})

test('startup refresh failure keeps retryable storage and reports an issue without exposing details', async () => {
  const tokenStore = new MemoryTokenStore('saved-refresh-token')
  const service = new TwitchChatService(
    () => ({ clientId: 'private-client', clientSecret: 'private-secret', redirectUri: 'http://localhost:3001/auth/twitch/callback' }),
    async () => { throw new Error('private Twitch response') },
    undefined,
    tokenStore,
  )

  assert.equal(await service.restoreAuthorization(), false)
  assert.equal(await tokenStore.load(), 'saved-refresh-token')
  assert.equal(service.getStatus().state, 'error')
  assert.equal(service.getStatus().subscription, 'error')
  assert.doesNotMatch(JSON.stringify(service.getStatus()), /saved-refresh-token|private Twitch response/)
})

test('startup without a saved grant stays disconnected and checks only once', async () => {
  const tokenStore = new MemoryTokenStore()
  let networkCalls = 0
  const service = new TwitchChatService(
    () => { throw new Error('configuration is not needed without saved authorization') },
    async () => { networkCalls += 1; throw new Error('unexpected request') },
    undefined,
    tokenStore,
  )

  const firstRestore = service.restoreAuthorization()
  const secondRestore = service.restoreAuthorization()
  assert.equal(firstRestore, secondRestore)
  assert.equal(await firstRestore, false)
  assert.equal(tokenStore.loads, 1)
  assert.equal(networkCalls, 0)
  assert.equal(service.getStatus().state, 'disconnected')
  assert.equal(service.getStatus().subscription, 'not_started')
})

test('revoked refresh tokens are removed so the dashboard can request consent again', async () => {
  const tokenStore = new MemoryTokenStore('revoked-refresh-token')
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback' }),
    async () => new Response('private invalid-token response', { status: 401 }),
    undefined,
    tokenStore,
  )

  assert.equal(await service.restoreAuthorization(), false)
  assert.equal(tokenStore.cleared, true)
  assert.equal(await tokenStore.load(), null)
  assert.equal(service.getStatus().state, 'error')
})

test('startup restoration and a simultaneous authorization share one socket and one subscription', async () => {
  const socket = new FakeSocket()
  const tokenStore = new MemoryTokenStore('saved-refresh-token')
  let socketCreations = 0
  let subscriptions = 0
  const service = new TwitchChatService(
    () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost:3001/auth/twitch/callback' }),
    async (input) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return new Response(JSON.stringify({ access_token: 'startup-access', refresh_token: 'startup-rotated' }), { status: 200 })
      if (url === 'https://id.twitch.tv/oauth2/validate') return new Response(JSON.stringify({ client_id: 'client', scopes: ['user:read:chat'] }), { status: 200 })
      if (url === 'https://api.twitch.tv/helix/users') return new Response(JSON.stringify({ data: [{ id: 'same-user' }] }), { status: 200 })
      subscriptions += 1
      return new Response(null, { status: 202 })
    },
    () => { socketCreations += 1; return socket },
    tokenStore,
  )

  const restoration = service.restoreAuthorization()
  const userAuthorization = service.authorize({ accessToken: 'new-access', refreshToken: 'new-refresh' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  socket.welcome('one-session')

  assert.equal(await restoration, true)
  assert.equal(await userAuthorization, true)
  assert.equal(socketCreations, 1)
  assert.equal(subscriptions, 3)
})
