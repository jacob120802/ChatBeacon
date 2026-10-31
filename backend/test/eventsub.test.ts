import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { EventSubConnection, EVENTSUB_WEBSOCKET_URL, buildChatSubscriptionPayload, buildStreamSubscriptionPayload, parseEventSubMessage, type RetryScheduler } from '../src/eventsub.ts'
import { RecentChatMessages } from '../src/messages.ts'

class FakeSocket extends EventEmitter {
  readyState = 0
  onOpen(listener: () => void): void { this.on('open', listener) }
  onMessage(listener: (data: Buffer) => void): void { this.on('message', listener) }
  onClose(listener: () => void): void { this.on('close', listener) }
  onError(listener: () => void): void { this.on('error', listener) }
  open(): void { this.readyState = 1; this.emit('open') }
  sendMessage(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value))) }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)) }
  fail(): void { this.emit('error', new Error('private socket detail')) }
}

class FakeRetryScheduler {
  readonly delays: number[] = []
  private readonly tasks: { callback: () => void; cancelled: boolean; completed: boolean }[] = []

  readonly schedule: RetryScheduler = (callback, delayMs) => {
    const task = { callback, cancelled: false, completed: false }
    this.delays.push(delayMs)
    this.tasks.push(task)
    return () => { task.cancelled = true }
  }

  runNext(): boolean {
    const task = this.tasks.find((candidate) => !candidate.cancelled && !candidate.completed)
    if (!task) return false
    task.completed = true
    task.callback()
    return true
  }
}

const welcome = (id: string) => ({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, keepalive_timeout_seconds: 10 } } })
const chatNotification = (id: string) => ({
  metadata: { message_type: 'notification', message_timestamp: '2026-10-28T12:00:00Z' },
  payload: { subscription: { type: 'channel.chat.message' }, event: { message_id: id, broadcaster_user_id: 'broadcaster-123', chatter_user_id: 'viewer-456', chatter_user_name: 'viewer42', message: { text: 'When is the next stream?' } } },
})

test('parses only safe fields from chat notifications and rejects malformed payloads', () => {
  assert.deepEqual(parseEventSubMessage(JSON.stringify(chatNotification('msg-1'))), {
    type: 'notification', streamEvent: null,
    chatMessage: { messageId: 'msg-1', timestamp: '2026-10-28T12:00:00Z', chatterName: 'viewer42', text: 'When is the next stream?', chatterUserId: 'viewer-456', broadcasterUserId: 'broadcaster-123' },
  })
  assert.deepEqual(parseEventSubMessage('not-json'), { type: 'invalid' })
  assert.deepEqual(parseEventSubMessage(JSON.stringify({ metadata: { message_type: 'notification' }, payload: {} })), { type: 'notification', chatMessage: null, streamEvent: null })

  const malformedTimestamp = chatNotification('msg-invalid-time')
  malformedTimestamp.metadata.message_timestamp = 'not-a-timestamp'
  assert.deepEqual(parseEventSubMessage(JSON.stringify(malformedTimestamp)), { type: 'notification', chatMessage: null, streamEvent: null })

  const emptyId = chatNotification('')
  assert.deepEqual(parseEventSubMessage(JSON.stringify(emptyId)), { type: 'notification', chatMessage: null, streamEvent: null })
})

test('bounds recent messages and deduplicates repeated notification IDs', () => {
  const messages = new RecentChatMessages(2, 4)
  const make = (messageId: string) => ({ messageId, timestamp: 'now', chatterName: 'viewer', text: 'hello' })
  assert.equal(messages.add(make('one')), true)
  assert.equal(messages.add(make('one')), false)
  messages.add(make('two'))
  messages.add(make('three'))
  assert.deepEqual(messages.getAll().map((message) => message.messageId), ['three', 'two'])
})

test('builds the own-account chat subscription condition', () => {
  assert.deepEqual(buildChatSubscriptionPayload('user-123', 'session-private'), {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: 'user-123', user_id: 'user-123' },
    transport: { method: 'websocket', session_id: 'session-private' },
  })
})

test('parses Twitch stream boundaries and builds their EventSub subscription payloads', () => {
  const online = { metadata: { message_type: 'notification', message_timestamp: '2026-10-30T12:01:00Z' }, payload: { subscription: { type: 'stream.online' }, event: { id: 'stream-1', broadcaster_user_id: 'user-123', started_at: '2026-10-30T12:00:00Z' } } }
  assert.deepEqual(parseEventSubMessage(JSON.stringify(online)), { type: 'notification', chatMessage: null, streamEvent: { kind: 'online', broadcasterId: 'user-123', streamId: 'stream-1', startedAt: '2026-10-30T12:00:00Z' } })
  const offline = { metadata: { message_type: 'notification', message_timestamp: '2026-10-30T13:00:00Z' }, payload: { subscription: { type: 'stream.offline' }, event: { broadcaster_user_id: 'user-123' } } }
  assert.deepEqual(parseEventSubMessage(JSON.stringify(offline)), { type: 'notification', chatMessage: null, streamEvent: { kind: 'offline', broadcasterId: 'user-123', occurredAt: '2026-10-30T13:00:00Z' } })
  assert.deepEqual(buildStreamSubscriptionPayload('stream.online', 'user-123', 'session-private'), { type: 'stream.online', version: '1', condition: { broadcaster_user_id: 'user-123' }, transport: { method: 'websocket', session_id: 'session-private' } })
})

test('subscribes immediately after welcome, handles chat, and reports safe status', async () => {
  const socket = new FakeSocket()
  const messages = new RecentChatMessages()
  const receivedNotifications: string[] = []
  const requests: { url: string; init?: RequestInit }[] = []
  const connection = new EventSubConnection(messages, (url) => { assert.equal(url, EVENTSUB_WEBSOCKET_URL); return socket }, async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(null, { status: 202 })
  }, undefined, undefined, undefined, undefined, undefined, undefined, (message) => { receivedNotifications.push(message.messageId) })
  const started = connection.start({ clientId: 'client-private', accessToken: 'token-private', userId: 'user-123' })
  socket.open()
  socket.sendMessage(welcome('session-private'))
  assert.equal(await started, true)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].url, 'https://api.twitch.tv/helix/eventsub/subscriptions')
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer token-private')
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), buildChatSubscriptionPayload('user-123', 'session-private'))
  socket.sendMessage(chatNotification('msg-1'))
  socket.sendMessage(chatNotification('msg-1'))
  assert.equal(messages.size, 1)
  assert.deepEqual(receivedNotifications, ['msg-1'])
  assert.deepEqual(messages.getAll()[0], { messageId: 'msg-1', timestamp: '2026-10-28T12:00:00Z', chatterName: 'viewer42', text: 'When is the next stream?' })
  assert.deepEqual(connection.getStatus(), { state: 'connected', subscription: 'enabled', sessionIdReceived: true, lastKeepaliveAt: null, messageCount: 1 })
  assert.equal(JSON.stringify(connection.getStatus()).includes('session-private'), false)
})

test('subscription API errors produce a safe error status', async () => {
  const socket = new FakeSocket()
  const retryScheduler = new FakeRetryScheduler()
  let authorizationInvalidations = 0
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => socket,
    async () => new Response('private API error', { status: 403 }),
    undefined,
    () => { authorizationInvalidations += 1 },
    retryScheduler.schedule,
  )
  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  socket.open()
  socket.sendMessage(welcome('session'))
  assert.equal(await started, false)
  assert.equal(connection.getStatus().state, 'error')
  assert.equal(connection.getStatus().subscription, 'error')
  assert.equal(authorizationInvalidations, 1)
  assert.equal(retryScheduler.runNext(), false)
})

test('duplicate start while subscription is pending does not open another socket', async () => {
  const socket = new FakeSocket()
  let creations = 0
  const connection = new EventSubConnection(new RecentChatMessages(), () => { creations += 1; return socket }, async () => new Response(null, { status: 202 }))
  const auth = { clientId: 'client', accessToken: 'token', userId: 'user' }
  const first = connection.start(auth)
  const second = connection.start(auth)
  assert.equal(first, second)
  assert.equal(creations, 1)
  socket.open()
  socket.sendMessage(welcome('session'))
  assert.equal(await first, true)
})

test('marks the subscription unhealthy after EventSub activity exceeds its welcome timeout', async () => {
  const socket = new FakeSocket()
  const retryScheduler = new FakeRetryScheduler()
  let now = Date.parse('2026-10-28T12:00:00.000Z')
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => socket,
    async () => new Response(null, { status: 202 }),
    () => new Date(now),
    undefined,
    retryScheduler.schedule,
  )

  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  socket.open()
  socket.sendMessage(welcome('session'))
  assert.equal(await started, true)
  assert.equal(connection.getStatus().state, 'connected')

  now += 10_001
  const staleStatus = connection.getStatus()
  assert.equal(staleStatus.state, 'connecting')
  assert.equal(staleStatus.subscription, 'pending')
  assert.equal(staleStatus.sessionIdReceived, false)
  assert.equal(socket.readyState, 3)
  assert.deepEqual(retryScheduler.delays, [1_000])
  connection.stop()
})

test('retries a socket that opens but never sends its welcome message', async () => {
  const socket = new FakeSocket()
  const retryScheduler = new FakeRetryScheduler()
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => socket,
    fetch,
    undefined,
    undefined,
    retryScheduler.schedule,
    [1_000],
    5,
  )

  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  assert.equal(await started, false)
  assert.equal(socket.readyState, 3)
  assert.equal(connection.getStatus().state, 'connecting')
  assert.equal(connection.getStatus().sessionIdReceived, false)
  assert.deepEqual(retryScheduler.delays, [1_000])
  connection.stop()
})

test('reconnects after an unexpected close and deduplicates overlap across sessions', async () => {
  const sockets: FakeSocket[] = []
  const retryScheduler = new FakeRetryScheduler()
  let subscriptions = 0
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    async () => { subscriptions += 1; return new Response(null, { status: 202 }) },
    undefined,
    undefined,
    retryScheduler.schedule,
  )
  const authorization = { clientId: 'client', accessToken: 'token', userId: 'user' }
  const firstStart = connection.start(authorization)
  sockets[0].open()
  sockets[0].sendMessage(welcome('first-session'))
  assert.equal(await firstStart, true)
  sockets[0].sendMessage(chatNotification('same-event'))
  sockets[0].close()
  sockets[0].close()

  assert.equal(connection.getStatus().state, 'connecting')
  assert.equal(retryScheduler.delays.length, 1)
  assert.equal(retryScheduler.runNext(), true)
  assert.equal(sockets.length, 2)
  const secondStart = connection.start(authorization)
  sockets[1].open()
  sockets[1].sendMessage(welcome('second-session'))
  assert.equal(await secondStart, true)
  sockets[0].sendMessage(chatNotification('same-event'))
  sockets[1].sendMessage(chatNotification('same-event'))

  assert.equal(connection.getStatus().state, 'connected')
  assert.equal(connection.getStatus().subscription, 'enabled')
  assert.equal(connection.getStatus().messageCount, 1)
  assert.equal(subscriptions, 6)
  connection.stop()
})

test('uses Twitch handover URL without creating a second subscription and keeps replacement socket active', async () => {
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  let subscriptionRequests = 0
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    (url) => { socketUrls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket },
    async () => { subscriptionRequests += 1; return new Response(null, { status: 202 }) },
  )
  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  sockets[0].open()
  sockets[0].sendMessage(welcome('original-session'))
  assert.equal(await started, true)
  sockets[0].sendMessage(chatNotification('handover-duplicate'))

  const reconnectUrl = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30&token=synthetic'
  sockets[0].sendMessage({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: reconnectUrl } } })
  assert.equal(sockets.length, 2)
  assert.equal(socketUrls[1], reconnectUrl)
  sockets[1].sendMessage(welcome('replacement-session'))
  sockets[1].sendMessage(chatNotification('handover-duplicate'))
  sockets[1].sendMessage(chatNotification('new-message'))

  assert.equal(connection.getStatus().state, 'connected')
  assert.equal(connection.getStatus().subscription, 'enabled')
  assert.equal(connection.getStatus().messageCount, 2)
  assert.equal(subscriptionRequests, 3)
  assert.equal(sockets[0].readyState, 3)
  connection.stop()
})

test('falls back to a fresh retry if Twitch handover does not welcome in time', async () => {
  const sockets: FakeSocket[] = []
  const retryScheduler = new FakeRetryScheduler()
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    async () => new Response(null, { status: 202 }),
    undefined,
    undefined,
    retryScheduler.schedule,
    [1_000],
    10_000,
    5,
  )
  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  sockets[0].open()
  sockets[0].sendMessage(welcome('initial-session'))
  assert.equal(await started, true)
  sockets[0].sendMessage({
    metadata: { message_type: 'session_reconnect' },
    payload: { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?synthetic=handover' } },
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 15))
  assert.equal(sockets.length, 2)
  assert.equal(sockets[0].readyState, 3)
  assert.equal(sockets[1].readyState, 3)
  assert.equal(connection.getStatus().state, 'connecting')
  assert.deepEqual(retryScheduler.delays, [1_000])
  connection.stop()
})

test('uses bounded exponential retries and ends in an actionable error state', async () => {
  const retryScheduler = new FakeRetryScheduler()
  let socketCreations = 0
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => { socketCreations += 1; throw new Error('temporary socket failure') },
    fetch,
    undefined,
    undefined,
    retryScheduler.schedule,
    [1_000, 2_000, 4_000],
  )

  assert.equal(await connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' }), false)
  assert.deepEqual(retryScheduler.delays, [1_000])
  assert.equal(retryScheduler.runNext(), true)
  assert.equal(retryScheduler.runNext(), true)
  assert.equal(retryScheduler.runNext(), true)
  assert.equal(retryScheduler.runNext(), false)
  assert.deepEqual(retryScheduler.delays, [1_000, 2_000, 4_000])
  assert.equal(socketCreations, 4)
  assert.equal(connection.getStatus().state, 'error')
  assert.equal(connection.getStatus().subscription, 'error')
})

test('intentional stop cancels pending retries', async () => {
  const socket = new FakeSocket()
  const retryScheduler = new FakeRetryScheduler()
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => socket,
    async () => new Response(null, { status: 202 }),
    undefined,
    undefined,
    retryScheduler.schedule,
  )
  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  socket.open()
  socket.sendMessage(welcome('session'))
  assert.equal(await started, true)
  socket.close()
  connection.stop()

  assert.equal(connection.getStatus().state, 'disconnected')
  assert.equal(connection.getStatus().subscription, 'not_started')
  assert.equal(retryScheduler.runNext(), false)
})

test('intentional stop during a pending subscription remains disconnected', async () => {
  const socket = new FakeSocket()
  const retryScheduler = new FakeRetryScheduler()
  let finishFetch: ((response: Response) => void) | undefined
  const pendingFetch = new Promise<Response>((resolve) => { finishFetch = resolve })
  const connection = new EventSubConnection(
    new RecentChatMessages(),
    () => socket,
    async () => pendingFetch,
    undefined,
    undefined,
    retryScheduler.schedule,
  )
  const started = connection.start({ clientId: 'client', accessToken: 'token', userId: 'user' })
  socket.open()
  socket.sendMessage(welcome('session'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  connection.stop()
  finishFetch?.(new Response(null, { status: 202 }))

  assert.equal(await started, false)
  assert.equal(connection.getStatus().state, 'disconnected')
  assert.equal(connection.getStatus().subscription, 'not_started')
  assert.equal(retryScheduler.runNext(), false)
})
