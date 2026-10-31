import WebSocket, { type RawData } from 'ws'
import type { ChatNotification, RecentChatMessages } from './messages.js'

export const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws'
const SUBSCRIPTION_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions'

export type ChatAuthorization = {
  clientId: string
  accessToken: string
  userId: string
}

export type EventSubConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'
export type EventSubStatus = {
  state: EventSubConnectionState
  subscription: 'not_started' | 'pending' | 'enabled' | 'error'
  sessionIdReceived: boolean
  lastKeepaliveAt: string | null
  messageCount: number
}

export type EventSubMessage =
  | { type: 'welcome'; sessionId: string; keepaliveTimeoutSeconds: number }
  | { type: 'keepalive' }
  | { type: 'reconnect'; reconnectUrl: string }
  | { type: 'notification'; chatMessage: ChatNotification | null; streamEvent: StreamLifecycleNotification | null }
  | { type: 'revocation'; authorizationRevoked: boolean }
  | { type: 'other' }
  | { type: 'invalid' }

type EventSubSocket = {
  readonly readyState: number
  onOpen(listener: () => void): void
  onMessage(listener: (data: RawData) => void): void
  onClose(listener: () => void): void
  onError(listener: () => void): void
  close(): void
}
type SocketFactory = (url: string) => EventSubSocket
type Fetcher = typeof fetch
export type RetryScheduler = (callback: () => void, delayMs: number) => () => void
export type ChatNotificationHandler = (message: ChatNotification) => void | Promise<void>
export type AuthorizationInvalidationReason = 'expired' | 'forbidden' | 'revoked'
export type StreamLifecycleNotification = { kind: 'online'; broadcasterId: string; streamId: string; startedAt: string } | { kind: 'offline'; broadcasterId: string; occurredAt: string } | { kind: 'snapshot'; broadcasterId: string; streamId: string | null; startedAt: string | null }
export type StreamLifecycleHandler = (event: StreamLifecycleNotification) => void | Promise<void>

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const
const STABLE_CONNECTION_RESET_MS = 60_000
const DEFAULT_WELCOME_TIMEOUT_MS = 10_000
const DEFAULT_HANDOVER_TIMEOUT_MS = 20_000
const scheduleTimeout: RetryScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function makeSocket(url: string): EventSubSocket {
  const socket = new WebSocket(url)
  return {
    get readyState() { return socket.readyState },
    onOpen: (listener) => { socket.on('open', listener) },
    onMessage: (listener) => { socket.on('message', (data) => listener(data)) },
    onClose: (listener) => { socket.on('close', listener) },
    onError: (listener) => { socket.on('error', () => listener()) },
    close: () => socket.close(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export function parseEventSubMessage(data: RawData | string): EventSubMessage {
  let decoded: unknown
  try { decoded = JSON.parse(typeof data === 'string' ? data : toText(data)) } catch { return { type: 'invalid' } }
  if (!isRecord(decoded) || !isRecord(decoded.metadata)) return { type: 'invalid' }
  const kind = decoded.metadata.message_type
  if (kind === 'session_keepalive') return { type: 'keepalive' }
  if (kind === 'session_welcome') {
    if (!isRecord(decoded.payload) || !isRecord(decoded.payload.session)) return { type: 'invalid' }
    const id = decoded.payload.session.id
    const timeout = decoded.payload.session.keepalive_timeout_seconds
    return typeof id === 'string' && id && typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0
      ? { type: 'welcome', sessionId: id, keepaliveTimeoutSeconds: timeout }
      : { type: 'invalid' }
  }
  if (kind === 'session_reconnect') {
    if (!isRecord(decoded.payload) || !isRecord(decoded.payload.session) || typeof decoded.payload.session.reconnect_url !== 'string') return { type: 'invalid' }
    return { type: 'reconnect', reconnectUrl: decoded.payload.session.reconnect_url }
  }
  if (kind === 'revocation') {
    const payload = isRecord(decoded.payload) ? decoded.payload : null
    const subscription = payload && isRecord(payload.subscription) ? payload.subscription : null
    return { type: 'revocation', authorizationRevoked: subscription?.status === 'authorization_revoked' }
  }
  if (kind === 'notification') {
    if (!isRecord(decoded.payload) || !isRecord(decoded.payload.subscription) || !isRecord(decoded.payload.event)) return { type: 'notification', chatMessage: null, streamEvent: null }
    const subscriptionType = decoded.payload.subscription.type
    const event = decoded.payload.event
    if (subscriptionType === 'stream.online') {
      return typeof event.id === 'string' && typeof event.broadcaster_user_id === 'string' && typeof event.started_at === 'string' && Number.isFinite(Date.parse(event.started_at))
        ? { type: 'notification', chatMessage: null, streamEvent: { kind: 'online', broadcasterId: event.broadcaster_user_id, streamId: event.id, startedAt: event.started_at } }
        : { type: 'notification', chatMessage: null, streamEvent: null }
    }
    if (subscriptionType === 'stream.offline') {
      const occurredAt = decoded.metadata.message_timestamp
      return typeof event.broadcaster_user_id === 'string' && typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt))
        ? { type: 'notification', chatMessage: null, streamEvent: { kind: 'offline', broadcasterId: event.broadcaster_user_id, occurredAt } }
        : { type: 'notification', chatMessage: null, streamEvent: null }
    }
    if (subscriptionType !== 'channel.chat.message') return { type: 'notification', chatMessage: null, streamEvent: null }
    const message = isRecord(event.message) ? event.message : null
    if (
      typeof event.message_id !== 'string' || !event.message_id.trim() ||
      typeof decoded.metadata.message_timestamp !== 'string' || !Number.isFinite(Date.parse(decoded.metadata.message_timestamp)) ||
      typeof event.chatter_user_name !== 'string' || !event.chatter_user_name.trim() ||
      !message || typeof message.text !== 'string'
    ) return { type: 'notification', chatMessage: null, streamEvent: null }
    return { type: 'notification', streamEvent: null, chatMessage: {
      messageId: event.message_id,
      timestamp: decoded.metadata.message_timestamp,
      chatterName: event.chatter_user_name,
      text: message.text,
      chatterUserId: typeof event.chatter_user_id === 'string' && event.chatter_user_id ? event.chatter_user_id : null,
      broadcasterUserId: typeof event.broadcaster_user_id === 'string' && event.broadcaster_user_id ? event.broadcaster_user_id : null,
    } }
  }
  return { type: 'other' }
}

export function buildChatSubscriptionPayload(userId: string, sessionId: string) {
  return {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: userId, user_id: userId },
    transport: { method: 'websocket', session_id: sessionId },
  }
}

export function buildStreamSubscriptionPayload(type: 'stream.online' | 'stream.offline', userId: string, sessionId: string) {
  return { type, version: '1', condition: { broadcaster_user_id: userId }, transport: { method: 'websocket', session_id: sessionId } }
}

export class EventSubConnection {
  private state: EventSubConnectionState = 'disconnected'
  private subscription: EventSubStatus['subscription'] = 'not_started'
  private sessionId: string | null = null
  private lastKeepaliveAt: string | null = null
  private lastActivityAt: number | null = null
  private keepaliveTimeoutMs: number | null = null
  private socket: EventSubSocket | null = null
  private handoverSocket: EventSubSocket | null = null
  private authorization: ChatAuthorization | null = null
  private startPromise: Promise<boolean> | null = null
  private finishPendingStart: ((success: boolean) => void) | null = null
  private pendingUserId: string | null = null
  private cancelRetry: (() => void) | null = null
  private retryAttempts = 0
  private intentionalStop = false
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null
  private handoverTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly messages: RecentChatMessages,
    private readonly createSocket: SocketFactory = makeSocket,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly onAuthorizationInvalidated: (reason: AuthorizationInvalidationReason) => void = () => undefined,
    private readonly scheduleRetry: RetryScheduler = scheduleTimeout,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
    private readonly welcomeTimeoutMs = DEFAULT_WELCOME_TIMEOUT_MS,
    private readonly handoverTimeoutMs = DEFAULT_HANDOVER_TIMEOUT_MS,
    private readonly onChatNotification: ChatNotificationHandler = () => undefined,
    private readonly onStreamLifecycle: StreamLifecycleHandler = () => undefined,
  ) {}

  start(auth: ChatAuthorization): Promise<boolean> {
    if (this.startPromise) {
      if (this.pendingUserId !== auth.userId) return Promise.resolve(false)
      this.authorization = auth
      return this.startPromise
    }
    if (this.socket && this.state === 'connected' && this.subscription === 'enabled' && this.authorization?.userId === auth.userId) {
      this.authorization = auth
      return Promise.resolve(true)
    }
    this.cancelScheduledRetry()
    this.retryAttempts = 0
    this.intentionalStop = false
    return this.openConnection(auth)
  }

  /** Replaces the active EventSub session after the access token has been refreshed. */
  restart(auth: ChatAuthorization): Promise<boolean> {
    this.stop()
    return this.start(auth)
  }

  private openConnection(auth: ChatAuthorization): Promise<boolean> {
    if (this.startPromise) return this.pendingUserId === auth.userId ? this.startPromise : Promise.resolve(false)
    this.stopSocket()
    this.authorization = auth
    this.subscription = 'pending'
    this.state = 'connecting'
    this.sessionId = null
    this.lastKeepaliveAt = null
    this.lastActivityAt = null
    this.keepaliveTimeoutMs = null
    let socket: EventSubSocket
    try { socket = this.createSocket(EVENTSUB_WEBSOCKET_URL) } catch {
      this.state = 'error'; this.subscription = 'error'
      this.scheduleReconnect()
      return Promise.resolve(false)
    }
    this.socket = socket
    this.pendingUserId = auth.userId
    this.startPromise = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        this.startPromise = null
        this.finishPendingStart = null
        this.pendingUserId = null
        resolve(success)
      }
      this.finishPendingStart = finish
      this.welcomeTimer = setTimeout(() => {
        if (this.socket === socket && this.sessionId === null) this.failSocket(socket, finish, 'error')
      }, this.welcomeTimeoutMs)
      this.welcomeTimer.unref?.()
      socket.onOpen(() => { if (this.socket === socket) this.state = 'connecting' })
      socket.onMessage((data) => {
        if (this.socket !== socket) return
        const parsed = parseEventSubMessage(data)
        if (parsed.type === 'welcome') {
          this.cancelWelcomeTimer()
          this.sessionId = parsed.sessionId
          this.lastActivityAt = this.now().getTime()
          this.keepaliveTimeoutMs = parsed.keepaliveTimeoutSeconds * 1_000
          void this.subscribe(socket, parsed.sessionId).then((ok) => finish(ok))
        } else if (parsed.type === 'keepalive') {
          this.lastActivityAt = this.now().getTime()
          this.lastKeepaliveAt = this.now().toISOString()
        } else if (parsed.type === 'notification') {
          this.lastActivityAt = this.now().getTime()
          if (parsed.chatMessage && this.messages.add(parsed.chatMessage)) this.dispatchChatNotification(parsed.chatMessage)
          if (parsed.streamEvent) this.dispatchStreamLifecycle(parsed.streamEvent)
        } else if (parsed.type === 'reconnect') {
          void this.followReconnect(socket, parsed.reconnectUrl)
        } else if (parsed.type === 'revocation') {
          if (parsed.authorizationRevoked) this.onAuthorizationInvalidated('revoked')
          this.state = 'error'; this.subscription = 'error'; this.authorization = null; this.sessionId = null; socket.close(); finish(false)
        } else if (parsed.type === 'invalid') {
          this.state = 'error'; this.subscription = 'error'; this.sessionId = null; socket.close(); finish(false)
        }
      })
      socket.onError(() => {
        this.failSocket(socket, finish, 'error')
      })
      socket.onClose(() => {
        this.failSocket(socket, finish, this.state === 'error' ? 'error' : 'disconnected')
      })
    })
    return this.startPromise
  }

  private async subscribe(socket: EventSubSocket, sessionId: string): Promise<boolean> {
    const auth = this.authorization
    if (!auth || this.socket !== socket) return false
    try {
      const payloads = [buildChatSubscriptionPayload(auth.userId, sessionId), buildStreamSubscriptionPayload('stream.online', auth.userId, sessionId), buildStreamSubscriptionPayload('stream.offline', auth.userId, sessionId)]
      const responses = await Promise.all(payloads.map((payload) => this.fetchImpl(SUBSCRIPTION_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.accessToken}`, 'client-id': auth.clientId, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      })))
      for (const response of responses) await response.body?.cancel().catch(() => undefined)
      if (this.socket !== socket) return false
      const failedResponse = responses.find((response) => !response.ok)
      if (failedResponse) {
        if (failedResponse.status === 401 || failedResponse.status === 403) {
          this.authorization = null
          this.onAuthorizationInvalidated(failedResponse.status === 401 ? 'expired' : 'forbidden')
        }
        this.state = 'error'; this.subscription = 'error'; this.sessionId = null; socket.close(); return false
      }
      this.state = 'connected'; this.subscription = 'enabled'
      this.cancelScheduledRetry()
      this.resetRetriesAfterStableConnection(socket)
      return true
    } catch {
      if (this.socket !== socket) return false
      this.state = 'error'; this.subscription = 'error'; this.sessionId = null; socket.close(); return false
    }
  }

  private async followReconnect(oldSocket: EventSubSocket, reconnectUrl: string): Promise<void> {
    if (this.handoverSocket) return
    let parsed: URL
    try { parsed = new URL(reconnectUrl) } catch { this.failSocket(oldSocket, () => undefined, 'error'); return }
    if (parsed.protocol !== 'wss:' || parsed.hostname !== 'eventsub.wss.twitch.tv') { this.failSocket(oldSocket, () => undefined, 'error'); return }
    let next: EventSubSocket
    try { next = this.createSocket(reconnectUrl) } catch { this.failSocket(oldSocket, () => undefined, 'error'); return }
    this.handoverSocket = next
    this.handoverTimer = setTimeout(() => {
      if (this.socket === oldSocket && this.handoverSocket === next) this.failSocket(oldSocket, () => undefined, 'error')
    }, this.handoverTimeoutMs)
    this.handoverTimer.unref?.()
    next.onMessage((data) => {
      if (this.socket !== oldSocket && this.socket !== next) return
      const message = parseEventSubMessage(data)
      if (message.type === 'welcome' && this.socket === oldSocket) {
        this.handoverSocket = null
        this.cancelHandoverTimer()
        this.socket = next; this.sessionId = message.sessionId; this.state = 'connected'; this.subscription = 'enabled'
        this.lastActivityAt = this.now().getTime(); this.keepaliveTimeoutMs = message.keepaliveTimeoutSeconds * 1_000
        this.resetRetriesAfterStableConnection(next)
        oldSocket.close()
      } else if (this.socket === next && message.type === 'notification') {
        this.lastActivityAt = this.now().getTime()
        if (message.chatMessage && this.messages.add(message.chatMessage)) this.dispatchChatNotification(message.chatMessage)
        if (message.streamEvent) this.dispatchStreamLifecycle(message.streamEvent)
      } else if (this.socket === next && message.type === 'keepalive') {
        this.lastActivityAt = this.now().getTime(); this.lastKeepaliveAt = this.now().toISOString()
      } else if (this.socket === next && message.type === 'reconnect') {
        void this.followReconnect(next, message.reconnectUrl)
      } else if (this.socket === next && message.type === 'revocation') {
        this.authorization = null
        if (message.authorizationRevoked) this.onAuthorizationInvalidated('revoked')
        this.failSocket(next, () => undefined, 'error')
      } else if (message.type === 'invalid') {
        const activeSocket = this.socket === next ? next : oldSocket
        this.failSocket(activeSocket, () => undefined, 'error')
      }
    })
    next.onClose(() => {
      if (this.socket === next) this.failSocket(next, () => undefined, 'disconnected')
      else if (this.socket === oldSocket) this.failSocket(oldSocket, () => undefined, 'disconnected')
    })
    next.onError(() => {
      this.failSocket(this.socket === next ? next : oldSocket, () => undefined, 'error')
    })
  }

  private dispatchChatNotification(message: ChatNotification): void {
    try {
      void Promise.resolve(this.onChatNotification(message)).catch(() => undefined)
    } catch {
      // Vote handling must never block chat ingestion or reconnect processing.
    }
  }

  private dispatchStreamLifecycle(event: StreamLifecycleNotification): void {
    try { void Promise.resolve(this.onStreamLifecycle(event)).catch(() => undefined) } catch { /* Stream history must not block EventSub. */ }
  }

  private stopSocket(): void {
    this.cancelWelcomeTimer()
    this.cancelHandoverTimer()
    const old = this.socket
    this.socket = null
    if (old) old.close()
    const handover = this.handoverSocket
    this.handoverSocket = null
    if (handover && handover !== old) handover.close()
  }

  private failSocket(
    socket: EventSubSocket,
    finish: (success: boolean) => void,
    state: 'disconnected' | 'error',
  ): void {
    if (this.socket !== socket) return
    this.socket = null
    const pendingHandover = this.handoverSocket
    this.handoverSocket = null
    this.sessionId = null
    this.state = state
    this.subscription = 'error'
    this.lastActivityAt = null
    this.keepaliveTimeoutMs = null
    this.cancelStableTimer()
    this.cancelWelcomeTimer()
    this.cancelHandoverTimer()
    finish(false)
    if (state === 'error') {
      try { socket.close() } catch { /* The socket is already unusable. */ }
    }
    if (pendingHandover && pendingHandover !== socket) {
      try { pendingHandover.close() } catch { /* The handover socket is already unusable. */ }
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.authorization || this.intentionalStop || this.cancelRetry) return
    if (this.retryAttempts >= this.retryDelaysMs.length) {
      this.state = 'error'
      this.subscription = 'error'
      this.sessionId = null
      return
    }

    const delayMs = this.retryDelaysMs[this.retryAttempts]
    this.retryAttempts += 1
    this.state = 'connecting'
    this.subscription = 'pending'
    this.sessionId = null
    this.cancelRetry = this.scheduleRetry(() => {
      this.cancelRetry = null
      const auth = this.authorization
      if (!auth || this.intentionalStop) return
      void this.openConnection(auth)
    }, delayMs)
  }

  private cancelScheduledRetry(): void {
    this.cancelRetry?.()
    this.cancelRetry = null
  }

  private resetRetriesAfterStableConnection(socket: EventSubSocket): void {
    this.cancelStableTimer()
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      if (this.socket === socket && this.state === 'connected' && this.subscription === 'enabled') {
        this.retryAttempts = 0
      }
    }, STABLE_CONNECTION_RESET_MS)
    this.stableTimer.unref?.()
  }

  private cancelStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private cancelWelcomeTimer(): void {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer)
    this.welcomeTimer = null
  }

  private cancelHandoverTimer(): void {
    if (this.handoverTimer) clearTimeout(this.handoverTimer)
    this.handoverTimer = null
  }

  /** Intentionally close the current session and prevent background retries. */
  stop(): void {
    this.intentionalStop = true
    this.cancelScheduledRetry()
    this.cancelStableTimer()
    this.retryAttempts = 0
    this.authorization = null
    this.stopSocket()
    this.finishPendingStart?.(false)
    this.state = 'disconnected'
    this.subscription = 'not_started'
    this.sessionId = null
    this.lastKeepaliveAt = null
    this.lastActivityAt = null
    this.keepaliveTimeoutMs = null
  }

  getStatus(): EventSubStatus {
    this.expireIfStale()
    return { state: this.state, subscription: this.subscription, sessionIdReceived: this.sessionId !== null, lastKeepaliveAt: this.lastKeepaliveAt, messageCount: this.messages.size }
  }

  private expireIfStale(): void {
    if (
      this.state !== 'connected' || this.subscription !== 'enabled' ||
      this.lastActivityAt === null || this.keepaliveTimeoutMs === null ||
      this.now().getTime() - this.lastActivityAt <= this.keepaliveTimeoutMs
    ) return

    const staleSocket = this.socket
    if (staleSocket) this.failSocket(staleSocket, this.finishPendingStart ?? (() => undefined), 'error')
  }

  markError(): void {
    this.intentionalStop = true
    this.cancelScheduledRetry()
    this.cancelStableTimer()
    this.stopSocket()
    this.finishPendingStart?.(false)
    this.authorization = null
    this.state = 'error'
    this.subscription = 'error'
    this.sessionId = null
  }

  markConnecting(): void {
    this.intentionalStop = false
    this.cancelScheduledRetry()
    this.cancelStableTimer()
    this.state = 'connecting'
    this.subscription = 'pending'
    this.sessionId = null
    this.lastKeepaliveAt = null
    this.lastActivityAt = null
    this.keepaliveTimeoutMs = null
  }

  markDisconnected(): void {
    this.stop()
  }
}
