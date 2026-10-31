import { createServer } from 'node:http'
import { getTwitchConfig } from './config.js'
import { createOAuthRoutes } from './oauth.js'
import { TwitchChatService } from './twitchChat.js'
import { analyzeCommunityPulse, analyzeStreamRecap, generatePollSuggestion, PulseError, type ProviderConfig } from './communityPulse.js'
import { parseVoteCommand, PollError, PollService, PollStorageError, toPublicPoll, type Poll } from './pollService.js'
import { ChatReplyLimiter, formatPollAnnouncement, formatVoteReply } from './chatReplies.js'
import { POLL_OVERLAY_HTML } from './pollOverlay.js'
import { calculateSessionMetrics, SessionError, SessionService, type SessionAnalysis } from './sessionService.js'
import { isAllowedMutationOrigin } from './requestSecurity.js'
import { decodePathSegment } from './pathInput.js'

const port = Number(process.env.PORT ?? 3001)
const host = '127.0.0.1'
const pollService = new PollService()
const sessionService = new SessionService()
const recapRequestsInFlight = new Set<string>()
const chatReplyLimiter = new ChatReplyLimiter()
let lastPollAnnouncementAt = 0
const twitchChat = new TwitchChatService(getTwitchConfig, fetch, undefined, undefined, async (message) => {
  // Chat stays in the live pipeline if local recap persistence fails. The
  // session service records a safe degraded-health flag for the dashboard.
  void sessionService.addMessage(message).catch(() => undefined)
  if (!message.chatterUserId || !message.broadcasterUserId || message.broadcasterUserId !== twitchChat.getAuthorizedUserId()) return
  const command = parseVoteCommand(message.text)
  if (!command) return
  const optionNumber = command.kind === 'vote' ? command.optionNumber : 0
  const receipt = await pollService.recordVote(message.broadcasterUserId, message.chatterUserId, message.messageId, optionNumber, message.timestamp)
  const reply = formatVoteReply(receipt)
  if (reply && twitchChat.canSendChatMessages() && chatReplyLimiter.reserve(message.chatterUserId, Date.now())) {
    await twitchChat.sendChatMessage(reply, message.messageId)
  }
}, async (event) => {
  if (event.broadcasterId !== twitchChat.getAuthorizedUserId()) return
  try {
    if (event.kind === 'online') await sessionService.streamOnline(event.broadcasterId, event.streamId, event.startedAt)
    else if (event.kind === 'offline') {
      await sessionService.streamOffline(event.broadcasterId, event.occurredAt)
      await pollService.closeActiveForBroadcaster(event.broadcasterId, event.occurredAt)
    }
    else {
      await sessionService.reconcileAfterRestart(event.broadcasterId, event.streamId)
      if (event.streamId && event.startedAt) await sessionService.streamOnline(event.broadcasterId, event.streamId, event.startedAt)
    }
  } catch { /* Persistence trouble must not interrupt chat ingestion. */ }
})
const oauth = createOAuthRoutes({
  getConfig: getTwitchConfig,
  onAuthorized: (tokens) => twitchChat.authorize(tokens),
  frontendUrl: process.env.FRONTEND_URL,
})

const server = createServer((request, response) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') &&
      !isAllowedMutationOrigin(request.headers.origin, process.env.FRONTEND_URL)) {
    response.writeHead(403, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ error: 'This browser origin is not allowed to change ChatBeacon data.' }))
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`)
  const pathname = requestUrl.pathname

  if (request.method === 'GET' && pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/status') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ ...twitchChat.getStatus(), chatWriteEnabled: twitchChat.canSendChatMessages(), sessionPersistence: sessionService.getPersistenceStatus() }))
    return
  }

  if (request.method === 'POST' && pathname === '/twitch/logout') {
    oauth.cancelPending()
    void twitchChat.logout().then((cleared) => {
      response.writeHead(cleared ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(cleared
        ? { signedOut: true, twitchAuthorizationRevoked: false }
        : { error: 'Disconnected, but saved sign-in could not be removed. Check backend/data permissions and retry Sign out before restarting.' }))
    })
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/messages') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ messages: twitchChat.getMessages() }))
    return
  }

  if (pathname === '/twitch/sessions' && request.method === 'GET') {
    void handleSessionRequest(response, async () => {
      const broadcasterId = requireBroadcasterId()
      const [sessions, polls] = await Promise.all([sessionService.list(broadcasterId), pollService.listForBroadcaster(broadcasterId)])
      const results = await Promise.all(sessions.map(async (session) => {
        const messages = await sessionService.getMessages(broadcasterId, session.id)
        const metrics = calculateSessionMetrics(session, messages, polls)
        return { ...publicSession(session), metrics }
      }))
      return { sessions: results }
    })
    return
  }

  const sessionPath = pathname.match(/^\/twitch\/sessions\/([^/]+)(?:\/(analyze|questions\/(?:status|priority)))?$/u)
  if (sessionPath) {
    const sessionId = decodePathSegment(sessionPath[1]!)
    if (sessionId === null) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'The session ID has invalid encoding.' }))
      return
    }
    const action = sessionPath[2]
    if (!action && request.method === 'GET') {
      void handleSessionRequest(response, async () => {
        const broadcasterId = requireBroadcasterId()
        const [session, messages, polls] = await Promise.all([
          sessionService.get(broadcasterId, sessionId), sessionService.getMessages(broadcasterId, sessionId), pollService.listForBroadcaster(broadcasterId),
        ])
        return { session: publicSession(session), metrics: calculateSessionMetrics(session, messages, polls), messages: messages.slice(-100).map(({ messageId, timestamp, chatterName, text }) => ({ messageId, timestamp, chatterName, text })) }
      })
      return
    }
    if (action === 'questions/status' && request.method === 'POST') {
      void handleSessionRequest(response, async () => {
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('questionId' in body) || !('status' in body) || typeof body.questionId !== 'string' || (body.status !== 'answered' && body.status !== 'unanswered' && body.status !== 'open' && body.status !== 'follow_up')) throw new SessionError('Question status must include a question ID and a valid question status.')
        await sessionService.setQuestionStatus(requireBroadcasterId(), sessionId, body.questionId, body.status === 'unanswered' ? 'open' : body.status)
        return { saved: true }
      })
      return
    }
    if (action === 'questions/priority' && request.method === 'POST') {
      void handleSessionRequest(response, async () => {
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('questionId' in body) || !('priority' in body) || typeof body.questionId !== 'string' || (body.priority !== 0 && body.priority !== 1 && body.priority !== 2)) throw new SessionError('Question priority must be 0, 1 or 2.')
        await sessionService.setQuestionPriority(requireBroadcasterId(), sessionId, body.questionId, body.priority)
        return { saved: true }
      })
      return
    }
    if (action === 'analyze' && request.method === 'POST') {
      void handleSessionRequest(response, async () => {
        const broadcasterId = requireBroadcasterId()
        if (recapRequestsInFlight.has(sessionId)) throw new SessionError('A recap for this session is already being generated.', 409)
        recapRequestsInFlight.add(sessionId)
        try {
        const session = await sessionService.get(broadcasterId, sessionId)
        if (session.status !== 'completed' && session.status !== 'interrupted') throw new SessionError('Finish the stream before generating its recap.', 409)
        const messages = await sessionService.getMessages(broadcasterId, sessionId)
        const boundedMessages = messages.slice(-100).map(({ messageId, timestamp, chatterName, text }) => ({ messageId, timestamp, chatterName, text }))
        const result = await analyzeStreamRecap(boundedMessages, getProviderConfig())
        const saved = await sessionService.saveAnalysis(broadcasterId, sessionId, { ...result.analysis, provider: result.provider, analyzedAt: new Date().toISOString() } as SessionAnalysis)
        return { session: publicSession(saved), analysis: saved.analysis }
        } finally { recapRequestsInFlight.delete(sessionId) }
      })
      return
    }
  }

  if (request.method === 'GET' && pathname === '/poll-overlay') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(POLL_OVERLAY_HTML)
    return
  }

  if (request.method === 'GET' && pathname === '/overlay/poll') {
    const broadcasterId = twitchChat.getAuthorizedUserId()
    if (!broadcasterId) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end('null')
    } else {
      void handlePollRequest(response, () => pollService.getOverlayPoll(broadcasterId))
    }
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/polls/current') {
    void handlePollRequest(response, () => pollService.getCurrent(requireBroadcasterId()))
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/polls/active') {
    void handlePollRequest(response, () => pollService.getActive(requireBroadcasterId()))
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/polls/results') {
    void handlePollRequest(response, () => pollService.getResults(requireBroadcasterId()))
    return
  }

  if (request.method === 'GET' && pathname === '/twitch/polls/status') {
    void handlePollRequest(response, async () => ({
      ...await pollService.getStatus(requireBroadcasterId()),
      chatWriteEnabled: twitchChat.canSendChatMessages(),
    }))
    return
  }

  const pollPath = pathname.match(/^\/twitch\/polls\/([^/]+)(?:\/(activate|close|announce))?$/u)
  if (pollPath) {
    const pollId = decodePathSegment(pollPath[1]!)
    if (pollId === null) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'The poll ID has invalid encoding.' }))
      return
    }
    const action = pollPath[2]
    if (!action && request.method === 'GET') {
      void handlePollRequest(response, () => pollService.getById(requireBroadcasterId(), pollId))
      return
    }
    if (!action && request.method === 'PATCH') {
      void handlePollRequest(response, async () => {
        const body = await readJsonBody(request)
        return pollService.editDraft(requireBroadcasterId(), pollId, pickPollFields(body))
      })
      return
    }
    if (action === 'activate' && request.method === 'POST') {
      void handlePollRequest(response, async () => {
        const broadcasterId = requireBroadcasterId()
        await pollService.activate(broadcasterId, pollId)
        return announcePoll(broadcasterId, pollId)
      })
      return
    }
    if (action === 'announce' && request.method === 'POST') {
      void handlePollRequest(response, () => announcePoll(requireBroadcasterId(), pollId))
      return
    }
    if (action === 'close' && request.method === 'POST') {
      void handlePollRequest(response, () => pollService.close(requireBroadcasterId(), pollId))
      return
    }
  }

  if (request.method === 'POST' && pathname === '/twitch/polls') {
    void handlePollRequest(response, async () => {
      const body = await readJsonBody(request)
      return pollService.createDraft(requireBroadcasterId(), pickPollFields(body))
    })
    return
  }

  if (request.method === 'POST' && pathname === '/community-pulse') {
    void handlePulseRequest(request, response, async (body) => {
      const result = await analyzeCommunityPulse(body && typeof body === 'object' && !Array.isArray(body) && 'messages' in body ? body.messages : undefined, getProviderConfig())
      const broadcasterId = twitchChat.getAuthorizedUserId()
      if (broadcasterId) {
        const activeSession = await sessionService.getActive(broadcasterId)
        if (activeSession) await sessionService.saveCommunityPulse(broadcasterId, activeSession.id, { ...result, analyzedAt: new Date().toISOString() })
      }
      return result
    })
    return
  }

  if (request.method === 'POST' && pathname === '/community-pulse/poll') {
    void handlePulseRequest(request, response, async (body) => {
      const broadcasterId = twitchChat.getAuthorizedUserId()
      const existingPollQuestions = broadcasterId
        ? (await pollService.listForBroadcaster(broadcasterId)).slice(-10).map((poll) => poll.question)
        : []
      const input = body && typeof body === 'object' && !Array.isArray(body) ? { ...body, existingPollQuestions } : body
      return generatePollSuggestion(input, getProviderConfig())
    })
    return
  }

  if (request.method === 'GET' && pathname === '/auth/twitch/login') {
    oauth.login(response)
    return
  }

  if (request.method === 'GET' && pathname === '/auth/twitch/callback') {
    void oauth.callback(request, response, requestUrl)
    return
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(port, host, () => {
  console.log(`ChatBeacon backend listening at http://${host}:${port}`)
  void twitchChat.restoreAuthorization()
})

function shutDown(): void {
  twitchChat.stop()
  server.close()
}

process.once('SIGINT', shutDown)
process.once('SIGTERM', shutDown)

let pulseRequestInFlight = false

function getProviderConfig(): ProviderConfig {
  return {
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
    cloudflareModel: process.env.CLOUDFLARE_MODEL,
  }
}

async function handlePulseRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  action: (body: unknown) => Promise<unknown>,
): Promise<void> {
  if (pulseRequestInFlight) {
    response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'Another Community Pulse request is still running. Try again shortly.' }))
    return
  }
  pulseRequestInFlight = true
  try {
    const body = await readJsonBody(request)
    const result = await action(body)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(result))
  } catch (error) {
    const statusCode = error instanceof PulseError ? error.statusCode : 500
    const message = error instanceof PulseError ? error.message : 'Community Pulse could not complete.'
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: message }))
  } finally {
    pulseRequestInFlight = false
  }
}

async function handleSessionRequest(response: import('node:http').ServerResponse, action: () => Promise<unknown>): Promise<void> {
  try {
    const result = await action()
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(result))
  } catch (error) {
    const statusCode = error instanceof SessionError ? error.statusCode : error instanceof PulseError ? error.statusCode : error instanceof PollError ? error.statusCode : 500
    const message = error instanceof SessionError || error instanceof PulseError || error instanceof PollError ? error.message : 'Stream recap could not be loaded.'
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: message }))
  }
}

function publicSession(session: Awaited<ReturnType<typeof sessionService.get>>) {
  const { uniqueViewerIds: _privateIds, ...safe } = session
  return { ...safe, captureComplete: session.captureComplete !== false, uniqueViewerCount: session.uniqueViewerIds.length }
}

function requireBroadcasterId(): string {
  const userId = twitchChat.getAuthorizedUserId()
  if (!userId) throw new PollError('Connect Twitch before managing polls.', 401)
  return userId
}

function pickPollFields(body: unknown): { question: unknown; options: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PollError('Poll data must be a JSON object.', 400)
  return { question: 'question' in body ? body.question : undefined, options: 'options' in body ? body.options : undefined }
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64_000) throw new PulseError('The request is too large.', 413)
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PulseError('Request body must be valid JSON.', 400) }
}

async function handlePollRequest(response: import('node:http').ServerResponse, action: () => Promise<unknown>): Promise<void> {
  try {
    const result = await action()
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(publicPollResponse(result)))
  } catch (error) {
    const statusCode = error instanceof PollError || error instanceof PulseError || error instanceof PollStorageError ? error.statusCode : 500
    const message = error instanceof PollError || error instanceof PulseError || error instanceof PollStorageError ? error.message : 'The poll request could not be completed.'
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: message }))
  }
}

async function announcePoll(broadcasterId: string, pollId: string): Promise<Poll> {
  const poll = await pollService.getById(broadcasterId, pollId)
  if (poll.status !== 'active') throw new PollError('Only an active poll can be announced.', 409)
  if (!twitchChat.canSendChatMessages()) {
    await pollService.setAnnouncementFeedback(broadcasterId, pollId, 'permission_required')
    return poll
  }
  const now = Date.now()
  if (now - lastPollAnnouncementAt < 5_000) throw new PollError('Please wait a few seconds before announcing another poll message.', 429)
  lastPollAnnouncementAt = now
  const sent = await twitchChat.sendChatMessage(formatPollAnnouncement(poll))
  await pollService.setAnnouncementFeedback(broadcasterId, pollId, sent ? 'sent' : 'failed')
  return pollService.getById(broadcasterId, pollId)
}

function publicPollResponse(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('broadcasterId' in result)) return result
  return toPublicPoll(result as Poll)
}
