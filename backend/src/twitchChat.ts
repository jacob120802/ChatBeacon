import { EventSubConnection, type AuthorizationInvalidationReason, type ChatAuthorization, type ChatNotificationHandler, type EventSubStatus, type StreamLifecycleHandler } from './eventsub.js'
import { RecentChatMessages, type ChatMessage } from './messages.js'
import type { TwitchConfiguration } from './oauth.js'
import { RefreshTokenStore, type RefreshTokenStorage } from './tokenStore.js'

const USERS_URL = 'https://api.twitch.tv/helix/users'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const CHAT_MESSAGES_URL = 'https://api.twitch.tv/helix/chat/messages'
const STREAMS_URL = 'https://api.twitch.tv/helix/streams'
const CHAT_SCOPE = 'user:read:chat'
const CHAT_WRITE_SCOPE = 'user:write:chat'

type ValidatedToken = 'valid' | 'invalid' | 'unavailable'
type AuthorizationStatus = { state: 'signed_in' | 'signed_out' | 'restoring' | 'error'; message?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSuccessfulJson(response: Response): Promise<unknown | null> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  try { return await response.json() } catch { return null }
}

export class TwitchChatService {
  private readonly messages = new RecentChatMessages(100)
  private readonly eventSub: EventSubConnection
  private operation: Promise<void> = Promise.resolve()
  private restoration: Promise<boolean> | null = null
  private refreshInFlight: Promise<boolean> | null = null
  private stopped = false
  private broadcasterId: string | null = null
  private accessToken: string | null = null
  private canWriteChat = false
  private authorizationGeneration = 0
  private signedOut = false
  private authorizationStatus: AuthorizationStatus = { state: 'signed_out' }

  constructor(
    private readonly getConfig: () => TwitchConfiguration,
    private readonly fetchImpl: typeof fetch = fetch,
    createSocket?: ConstructorParameters<typeof EventSubConnection>[1],
    private readonly tokenStore: RefreshTokenStorage = new RefreshTokenStore(),
    onChatNotification: ChatNotificationHandler = () => undefined,
    private readonly onStreamLifecycle?: StreamLifecycleHandler,
  ) {
    this.eventSub = new EventSubConnection(
      this.messages,
      createSocket,
      fetchImpl,
      undefined,
      (reason) => this.handleAuthorizationInvalidated(reason),
      undefined,
      undefined,
      undefined,
      undefined,
      onChatNotification,
      onStreamLifecycle,
    )
  }

  authorize(tokens: { accessToken: string; refreshToken: string; scopes?: string[] }): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    const generation = this.authorizationGeneration
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return false
      this.signedOut = false
      this.authorizationStatus = { state: 'restoring' }
      this.broadcasterId = null
      this.accessToken = null
      this.canWriteChat = Boolean(tokens.scopes?.includes(CHAT_WRITE_SCOPE))
      let config: TwitchConfiguration
      try { config = this.getConfig() } catch { this.markAuthorizationError(); return false }
      try {
        await this.tokenStore.save(tokens.refreshToken)
      } catch {
        if (this.isCurrent(generation)) this.markAuthorizationError()
        return false
      }
      if (!this.isCurrent(generation)) return false
      return this.connectWithAccessToken(tokens.accessToken, config, false, generation)
    })
  }

  restoreAuthorization(): Promise<boolean> {
    if (this.stopped || this.signedOut) return Promise.resolve(false)
    if (this.restoration) return this.restoration
    this.accessToken = null
    this.canWriteChat = false
    this.authorizationStatus = { state: 'restoring' }
    this.eventSub.markConnecting()
    const generation = this.authorizationGeneration
    this.restoration = this.enqueue(() => this.restoreSavedAuthorization(false, generation))
    return this.restoration
  }

  private refreshAuthorization(): Promise<boolean> {
    if (this.stopped || this.signedOut) return Promise.resolve(false)
    if (this.refreshInFlight) return this.refreshInFlight
    const generation = this.authorizationGeneration
    const refresh = this.enqueue(() => this.restoreSavedAuthorization(true, generation))
    this.refreshInFlight = refresh
    void refresh.then(
      () => { if (this.refreshInFlight === refresh) this.refreshInFlight = null },
      () => { if (this.refreshInFlight === refresh) this.refreshInFlight = null },
    )
    return refresh
  }

  private handleAuthorizationInvalidated(reason: AuthorizationInvalidationReason): void {
    if (this.stopped || this.signedOut) return
    this.broadcasterId = null
    this.accessToken = null
    this.canWriteChat = false
    this.authorizationStatus = { state: 'error', message: 'Twitch authorization needs attention. Sign in again.' }
    if (reason === 'revoked') {
      const generation = this.authorizationGeneration
      void this.enqueue(async () => { if (this.isCurrent(generation)) await this.clearSavedAuthorization(); return false })
    } else if (reason === 'expired') {
      void this.refreshAuthorization()
    }
  }

  private enqueue(task: () => Promise<boolean>): Promise<boolean> {
    const result = this.operation.then(task, task)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async restoreSavedAuthorization(restartEventSub = false, generation = this.authorizationGeneration): Promise<boolean> {
    if (!this.isCurrent(generation) || this.signedOut) return false
    this.authorizationStatus = { state: 'restoring' }
    this.broadcasterId = null
    this.accessToken = null
    this.canWriteChat = false
    let refreshToken: string | null
    try { refreshToken = await this.tokenStore.load() } catch {
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }
    if (!this.isCurrent(generation)) return false

    if (!refreshToken) {
      this.authorizationStatus = { state: 'signed_out' }
      this.eventSub.markDisconnected()
      return false
    }

    let config: TwitchConfiguration
    try { config = this.getConfig() } catch {
      this.markAuthorizationError()
      return false
    }

    let refreshResponse: Response
    try {
      refreshResponse = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }
    if (!this.isCurrent(generation)) {
      await refreshResponse.body?.cancel().catch(() => undefined)
      return false
    }

    if (!refreshResponse.ok) {
      if (refreshResponse.status === 400 || refreshResponse.status === 401) await this.clearSavedAuthorization()
      await refreshResponse.body?.cancel().catch(() => undefined)
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }

    const refreshedData = await readSuccessfulJson(refreshResponse)
    if (!this.isCurrent(generation)) return false
    if (!isRecord(refreshedData) || typeof refreshedData.access_token !== 'string' || !refreshedData.access_token) {
      this.markAuthorizationError()
      return false
    }

    const replacementRefreshToken = typeof refreshedData.refresh_token === 'string' && refreshedData.refresh_token
      ? refreshedData.refresh_token
      : refreshToken
    try {
      // Save a rotated refresh token before doing any further API calls.
      await this.tokenStore.save(replacementRefreshToken)
    } catch {
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }
    if (!this.isCurrent(generation)) return false

    const tokenStatus = await this.validateAccessToken(refreshedData.access_token, config)
    if (!this.isCurrent(generation)) { this.canWriteChat = false; return false }
    if (tokenStatus === 'invalid') {
      await this.clearSavedAuthorization()
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }
    if (tokenStatus === 'unavailable') {
      this.markAuthorizationError()
      return false
    }
    if (!this.isCurrent(generation)) return false

    return this.connectWithAccessToken(refreshedData.access_token, config, restartEventSub, generation)
  }

  private async validateAccessToken(accessToken: string, config: TwitchConfiguration): Promise<ValidatedToken> {
    let response: Response
    try {
      response = await this.fetchImpl(VALIDATE_URL, {
        method: 'GET',
        headers: { authorization: `OAuth ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
    } catch { return 'unavailable' }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      return 'invalid'
    }
    const data = await readSuccessfulJson(response)
    if (!response.ok || !isRecord(data)) return 'unavailable'
    if (
      data.client_id !== config.clientId ||
      !Array.isArray(data.scopes) ||
      !data.scopes.includes(CHAT_SCOPE)
    ) return 'invalid'
    this.canWriteChat = data.scopes.includes(CHAT_WRITE_SCOPE)
    return 'valid'
  }

  private async connectWithAccessToken(accessToken: string, config: TwitchConfiguration, restartEventSub = false, generation = this.authorizationGeneration): Promise<boolean> {
    let response: Response
    try {
      response = await this.fetchImpl(USERS_URL, {
        headers: { authorization: `Bearer ${accessToken}`, 'client-id': config.clientId },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      if (this.isCurrent(generation)) this.markAuthorizationError()
      return false
    }
    if (!this.isCurrent(generation)) {
      await response.body?.cancel().catch(() => undefined)
      return false
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      this.markAuthorizationError()
      if (response.status === 401 && !restartEventSub) void this.refreshAuthorization()
      return false
    }
    const data: unknown = await readSuccessfulJson(response)
    if (!this.isCurrent(generation)) return false
    if (!response.ok || !isUserResponse(data) || !data.data[0]?.id) {
      this.markAuthorizationError()
      return false
    }

    this.broadcasterId = data.data[0].id
    this.accessToken = accessToken
    this.authorizationStatus = { state: 'signed_in' }
    const auth: ChatAuthorization = { clientId: config.clientId, accessToken, userId: data.data[0].id }
    if (!this.isCurrent(generation)) return false
    const connected = await (restartEventSub ? this.eventSub.restart(auth) : this.eventSub.start(auth))
    if (!this.isCurrent(generation)) return false
    if (connected && this.onStreamLifecycle) await this.syncCurrentStream(auth, generation)
    return connected
  }

  private async syncCurrentStream(auth: ChatAuthorization, generation: number): Promise<void> {
    const notify = this.onStreamLifecycle
    if (!notify) return
    try {
      const response = await this.fetchImpl(`${STREAMS_URL}?user_id=${encodeURIComponent(auth.userId)}&type=live&first=1`, {
        headers: { authorization: `Bearer ${auth.accessToken}`, 'client-id': auth.clientId },
        signal: AbortSignal.timeout(8_000),
      })
      const data: unknown = await readSuccessfulJson(response)
      if (!this.isCurrent(generation)) return
      if (!response.ok || !isRecord(data) || !Array.isArray(data.data)) return
      const stream = data.data[0]
      const current = isRecord(stream) && typeof stream.id === 'string' && typeof stream.started_at === 'string' && Number.isFinite(Date.parse(stream.started_at))
        ? { streamId: stream.id, startedAt: stream.started_at } : null
      await notify({ kind: 'snapshot', broadcasterId: auth.userId, streamId: current?.streamId ?? null, startedAt: current?.startedAt ?? null })
    } catch { /* Current-stream lookup is best effort; EventSub remains connected. */ }
  }

  private async clearSavedAuthorization(): Promise<void> {
    this.broadcasterId = null
    this.accessToken = null
    this.canWriteChat = false
    try { await this.tokenStore.clear() } catch { /* Keep the public status generic and secret-free. */ }
  }

  getStatus(): EventSubStatus & { authorization: AuthorizationStatus } {
    return { ...this.eventSub.getStatus(), authorization: { ...this.authorizationStatus } }
  }

  /** Local sign-out; Twitch's account-level app grant is managed on Twitch. */
  logout(): Promise<boolean> {
    this.authorizationGeneration += 1
    this.signedOut = true
    this.broadcasterId = null
    this.accessToken = null
    this.canWriteChat = false
    this.authorizationStatus = { state: 'signed_out' }
    this.eventSub.stop()
    this.messages.clear()
    this.restoration = null
    this.refreshInFlight = null
    // Wait for any earlier token-file write, then erase it. No old operation can
    // reconnect because its generation has already been invalidated above.
    return this.enqueue(async () => {
      try { await this.tokenStore.clear(); return true } catch {
        this.authorizationStatus = { state: 'error', message: 'Disconnected, but saved sign-in could not be removed. Check backend/data permissions and retry Log out before restarting.' }
        return false
      }
    })
  }
  getAuthorizedUserId(): string | null { return this.broadcasterId }
  canSendChatMessages(): boolean { return this.canWriteChat && Boolean(this.accessToken && this.broadcasterId) }
  async sendChatMessage(message: string, replyParentMessageId?: string): Promise<boolean> {
    if (!message.trim()) return false
    const generation = this.authorizationGeneration
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.isCurrent(generation)) return false
      const config = this.getConfigSafe()
      if (!config || !this.canSendChatMessages() || !this.accessToken || !this.broadcasterId) return false
      let response: Response
      try {
        response = await this.fetchImpl(CHAT_MESSAGES_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.accessToken}`, 'client-id': config.clientId, 'content-type': 'application/json' },
          body: JSON.stringify({
            broadcaster_id: this.broadcasterId,
            sender_id: this.broadcasterId,
            message,
            ...(replyParentMessageId ? { reply_parent_message_id: replyParentMessageId } : {}),
          }),
          signal: AbortSignal.timeout(8_000),
        })
      } catch { return false }
      if (!this.isCurrent(generation)) { await response.body?.cancel().catch(() => undefined); return false }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel().catch(() => undefined)
        this.canWriteChat = false
        if (await this.refreshAuthorization()) continue
        return false
      }
      if (response.status === 401 || response.status === 403) this.canWriteChat = false
      const data: unknown = await readSuccessfulJson(response)
      if (!response.ok || !isRecord(data) || !Array.isArray(data.data) || !isRecord(data.data[0])) return false
      return data.data[0].is_sent === true
    }
    return false
  }
  getMessages(): ChatMessage[] { return this.messages.getAll() }
  stop(): void {
    this.stopped = true
    this.authorizationGeneration += 1
    this.broadcasterId = null
    this.accessToken = null
    this.canWriteChat = false
    this.eventSub.stop()
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.authorizationGeneration
  }

  private markAuthorizationError(): void {
    this.authorizationStatus = { state: 'error', message: 'Twitch sign-in could not be restored. Try signing in again.' }
    this.eventSub.markError()
  }

  private getConfigSafe(): TwitchConfiguration | null {
    try { return this.getConfig() } catch { return null }
  }
}

function isUserResponse(value: unknown): value is { data: Array<{ id: string }> } {
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) return false
  const first: unknown = value.data[0]
  return typeof first === 'object' && first !== null && 'id' in first && typeof first.id === 'string'
}
