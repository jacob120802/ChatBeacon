import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatNotification } from './messages.js'
import type { CommunityPulse } from './communityPulse.js'

export type SessionStatus = 'active' | 'completed' | 'interrupted'
export type SessionMessage = ChatNotification
export type SessionAnalysis = {
  insufficientData: boolean
  insufficientReason?: string
  summary: string
  topics: Array<{ title: string; explanation: string; messageIds: string[] }>
  recurringQuestions: Array<{ text: string; messageIds: string[] }>
  audienceRequests: Array<{ text: string; messageIds: string[] }>
  nextStreamTopics: Array<{ text: string; messageIds: string[] }>
  contentIdeas: Array<{ text: string; messageIds: string[] }>
  provider: string
  analyzedAt: string
}
export type StoredCommunityPulse = { pulse: CommunityPulse; provider: string; analyzedAt: string }
export type StreamSession = {
  id: string
  streamId: string
  broadcasterId: string
  startedAt: string
  endedAt: string | null
  /** Data association cutoff when a later stream superseded an interrupted session; not a stream end time. */
  supersededAt: string | null
  status: SessionStatus
  /** False once a write failure means one or more events may be missing. */
  captureComplete?: boolean
  totalMessages: number
  uniqueViewerIds: string[]
  questionStatuses: Record<string, 'open' | 'answered' | 'follow_up'>
  questionPriorities?: Record<string, 0 | 1 | 2>
  analysis: SessionAnalysis | null
  communityPulse: StoredCommunityPulse | null
}

export type SessionQuestion = { id: string; text: string; messageIds: string[]; authors: string[]; firstSeenAt: string; lastSeenAt: string; status: 'open' | 'answered' | 'follow_up'; priority: 0 | 1 | 2 }

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATH = resolve(backendDirectory, 'data', 'sessions.json')
const AUXILIARY_START = /^(?:can|could|would|will|should|do|does|did|is|are|was|were|have|has|had|may|might)\s+(?:i|we|you|they|he|she|it|there|anyone|someone|somebody|anybody)\b/iu
const WH_WORD = /^(what|when|where|who|whom|whose|why|which|how)\b/iu
const HELPER_WORD = /^(?:is|are|was|were|do|does|did|can|could|would|will|should|have|has|had|might|may)\b/iu
const QUESTION_NOUNS = new Set(['about','app','build','character','channel','class','country','date','day','episode','else','game','happened','item','keyboard','level','map','name','next','platform','price','said','song','stream','time','to','weapon','who','why','won'])
const HOW_QUESTION_CUES = new Set(['about','are','can','come','could','did','do','does','far','is','long','many','might','much','often','old','should','to','was','were','will','would'])
const HOW_EXCLAMATION_WORDS = new Set(['amazing','awesome','beautiful','cool','fun','funny','great','lovely','nice','strange','terrible','weird','wonderful'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export class SessionError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message) }
}

export class SessionService {
  private sessions: StreamSession[] = []
  private messageCache = new Map<string, SessionMessage[]>()
  private loaded = false
  private sessionIndexHealth: 'unknown' | 'healthy' | 'degraded' = 'unknown'
  private messageHistoryHealth: 'unknown' | 'healthy' | 'degraded' = 'unknown'
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = DEFAULT_PATH, private readonly now: () => Date = () => new Date(), private readonly makeId = randomUUID) {}

  getPersistenceStatus(): { state: 'unknown' | 'healthy' | 'degraded'; historyMayBeIncomplete: boolean } {
    const state = this.sessionIndexHealth === 'degraded' || this.messageHistoryHealth === 'degraded'
      ? 'degraded'
      : this.sessionIndexHealth === 'healthy' && this.messageHistoryHealth === 'healthy' ? 'healthy' : 'unknown'
    return {
      state,
      historyMayBeIncomplete: state === 'degraded' || this.sessions.some((session) => session.captureComplete === false),
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action, action)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try { text = await readFile(this.filePath, 'utf8') } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return
      this.loaded = false
      this.sessionIndexHealth = 'degraded'
      throw new SessionError('Session data could not be read.', 503)
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!Array.isArray(parsed) || !parsed.every(isValidSession)) throw new Error('invalid')
      this.sessions = parsed.map((session) => ({ ...structuredClone(session), captureComplete: session.captureComplete ?? true, supersededAt: session.supersededAt ?? null, communityPulse: session.communityPulse ?? null }))
      let recoveredCounts = false
      for (const session of this.sessions) {
        const messages = await this.readMessageFile(session.id)
        this.messageCache.set(session.id, messages)
        const viewers = [...new Set(messages.flatMap((message) => message.chatterUserId ? [message.chatterUserId] : []))]
        if (session.totalMessages !== messages.length || JSON.stringify(session.uniqueViewerIds) !== JSON.stringify(viewers)) {
          session.totalMessages = messages.length
          session.uniqueViewerIds = viewers
          recoveredCounts = true
        }
      }
      if (recoveredCounts) await this.save()
    } catch (error) {
      this.loaded = false
      this.sessionIndexHealth = 'degraded'
      if (error instanceof SessionError) throw error
      throw new SessionError('Session data is invalid.', 503)
    }
  }

  private async save(): Promise<void> {
    const temporary = `${this.filePath}.${this.makeId()}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(this.sessions)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filePath)
      this.sessionIndexHealth = 'healthy'
    } catch {
      await unlink(temporary).catch(() => undefined)
      this.sessionIndexHealth = 'degraded'
      for (const session of this.sessions) session.captureComplete = false
      throw new SessionError('Session data could not be saved.', 503)
    }
  }

  /** Twitch stream IDs make duplicate online notifications and process restarts idempotent. */
  async streamOnline(broadcasterId: string, streamId: string, startedAt: string): Promise<StreamSession> {
    return this.exclusive(async () => {
      await this.load()
      if (!broadcasterId || !streamId || !Number.isFinite(Date.parse(startedAt))) throw new SessionError('Twitch stream details were invalid.')
      const existing = this.sessions.find((session) => session.broadcasterId === broadcasterId && session.streamId === streamId)
      if (existing) return structuredClone(existing)
      for (const prior of this.sessions) {
        if (prior.broadcasterId === broadcasterId && (prior.status === 'active' || (prior.status === 'interrupted' && !prior.supersededAt))) {
          if (prior.status === 'active') prior.status = 'interrupted'
          prior.supersededAt = new Date(startedAt).toISOString()
        }
      }
      const session: StreamSession = {
        id: this.makeId(), streamId, broadcasterId, startedAt: new Date(startedAt).toISOString(), endedAt: null, supersededAt: null,
        status: 'active', captureComplete: true, totalMessages: 0, uniqueViewerIds: [], questionStatuses: {}, analysis: null, communityPulse: null,
      }
      this.sessions.push(session)
      this.messageCache.set(session.id, [])
      await this.save()
      return structuredClone(session)
    })
  }

  async streamOffline(broadcasterId: string, occurredAt: string): Promise<StreamSession | null> {
    return this.exclusive(async () => {
      await this.load()
      const active = [...this.sessions].reverse().find((session) => session.broadcasterId === broadcasterId && session.status === 'active')
      if (!active) return null
      const time = Date.parse(occurredAt)
      if (!Number.isFinite(time) || time < Date.parse(active.startedAt)) throw new SessionError('Twitch stream end time was invalid.')
      active.status = 'completed'
      active.endedAt = new Date(time).toISOString()
      await this.save()
      return structuredClone(active)
    })
  }

  /** Preserve an uncertain end as interrupted; never fabricate an offline timestamp. */
  async reconcileAfterRestart(broadcasterId: string, liveStreamId: string | null): Promise<void> {
    await this.exclusive(async () => {
      await this.load()
      let changed = false
      for (const session of this.sessions) {
        if (session.broadcasterId === broadcasterId && session.status === 'active' && session.streamId !== liveStreamId) {
          session.status = 'interrupted'
          changed = true
        }
      }
      if (changed) await this.save()
    })
  }

  async addMessage(message: ChatNotification): Promise<void> {
    await this.exclusive(async () => {
      await this.load()
      const session = [...this.sessions].reverse().find((item) => item.broadcasterId === message.broadcasterUserId && item.status === 'active')
      if (!session) return
      if (!Number.isFinite(Date.parse(message.timestamp)) || !message.messageId) return
      // EventSub IDs are globally unique. Keep private viewer IDs only for exact unique-viewer counts.
      const messages = this.messageCache.get(session.id) ?? await this.readMessageFile(session.id)
      this.messageCache.set(session.id, messages)
      if (messages.some((item) => item.messageId === message.messageId)) return
      const messageFile = `${this.filePath}.${session.id}.messages.jsonl`
      try {
        await mkdir(dirname(messageFile), { recursive: true, mode: 0o700 })
        await appendFile(messageFile, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 })
        this.messageHistoryHealth = 'healthy'
      } catch {
        session.captureComplete = false
        this.messageHistoryHealth = 'degraded'
        // Persist the warning when possible; the missing message itself is never treated as saved.
        await this.save().catch(() => undefined)
        throw new SessionError('Session message history could not be saved.', 503)
      }
      messages.push(structuredClone(message))
      session.totalMessages += 1
      if (message.chatterUserId && !session.uniqueViewerIds.includes(message.chatterUserId)) session.uniqueViewerIds.push(message.chatterUserId)
      // Chat is persisted in the append-only message log. The compact index counters are
      // recovered from that log on restart, avoiding a whole-index rewrite per message.
    })
  }

  async setQuestionStatus(broadcasterId: string, sessionId: string, questionId: string, status: 'open' | 'answered' | 'follow_up'): Promise<void> {
    await this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      if (questionId.length > 500) throw new SessionError('Question reference is invalid.')
      if (!['open', 'answered', 'follow_up'].includes(status)) throw new SessionError('Question status is invalid.')
      const questions = groupSessionQuestions(session, this.messageCache.get(session.id) ?? await this.readMessageFile(session.id))
      const legacyId = questionId.startsWith('live:') ? questionId.slice(5) : null
      const ownedQuestion = questions.find((question) => question.id === questionId || (legacyId !== null && question.id.endsWith(`:${legacyId}`)))
      if (!ownedQuestion) throw new SessionError('Question was not found in this stream session.', 404)
      session.questionStatuses[ownedQuestion.id] = status
      await this.save()
    })
  }

  async setQuestionPriority(broadcasterId: string, sessionId: string, questionId: string, priority: 0 | 1 | 2): Promise<void> {
    return this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      if (![0, 1, 2].includes(priority)) throw new SessionError('Question priority is invalid.')
      const questions = groupSessionQuestions(session, this.messageCache.get(session.id) ?? await this.readMessageFile(session.id))
      if (!questions.some((question) => question.id === questionId)) throw new SessionError('Question was not found in this stream session.', 404)
      session.questionPriorities ??= {}
      session.questionPriorities[questionId] = priority
      await this.save()
    })
  }

  async getMessages(broadcasterId: string, sessionId: string): Promise<SessionMessage[]> {
    return this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      return (this.messageCache.get(session.id) ?? await this.readMessageFile(session.id)).map((message) => structuredClone(message))
    })
  }

  async list(broadcasterId: string): Promise<StreamSession[]> {
    return this.exclusive(async () => { await this.load(); return this.sessions.filter((item) => item.broadcasterId === broadcasterId).sort((a,b) => Date.parse(b.startedAt)-Date.parse(a.startedAt)).map((item) => structuredClone(item)) })
  }

  async getActive(broadcasterId: string): Promise<StreamSession | null> {
    return this.exclusive(async () => {
      await this.load()
      const session = [...this.sessions].reverse().find((item) => item.broadcasterId === broadcasterId && item.status === 'active')
      return session ? structuredClone(session) : null
    })
  }

  async listFollowUps(broadcasterId: string): Promise<Array<{ sessionId: string; sessionStartedAt: string; question: SessionQuestion }>> {
    return this.exclusive(async () => {
      await this.load()
      const result: Array<{ sessionId: string; sessionStartedAt: string; question: SessionQuestion }> = []
      for (const session of this.sessions) {
        if (session.broadcasterId !== broadcasterId) continue
        const groups = groupSessionQuestions(session, this.messageCache.get(session.id) ?? await this.readMessageFile(session.id))
        for (const question of groups) if (question.status === 'follow_up') result.push({ sessionId: session.id, sessionStartedAt: session.startedAt, question })
      }
      return result
    })
  }

  async get(broadcasterId: string, sessionId: string): Promise<StreamSession> {
    return this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      return structuredClone(session)
    })
  }

  async saveAnalysis(broadcasterId: string, sessionId: string, analysis: SessionAnalysis): Promise<StreamSession> {
    return this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      session.analysis = structuredClone(analysis)
      await this.save()
      return structuredClone(session)
    })
  }

  async saveCommunityPulse(broadcasterId: string, sessionId: string, communityPulse: StoredCommunityPulse): Promise<void> {
    await this.exclusive(async () => {
      await this.load()
      const session = this.sessions.find((item) => item.id === sessionId && item.broadcasterId === broadcasterId)
      if (!session) throw new SessionError('Session not found.', 404)
      session.communityPulse = structuredClone(communityPulse)
      await this.save()
    })
  }

  private async readMessageFile(sessionId: string): Promise<SessionMessage[]> {
    try {
      const contents = await readFile(`${this.filePath}.${sessionId}.messages.jsonl`, 'utf8')
      return contents.split(/\r?\n/u).filter(Boolean).map((line) => {
        const message: unknown = JSON.parse(line)
        if (!isRecord(message) || typeof message.messageId !== 'string' || typeof message.timestamp !== 'string' || typeof message.chatterName !== 'string' || typeof message.text !== 'string') throw new Error('invalid message')
        return message as unknown as SessionMessage
      })
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return []
      this.messageHistoryHealth = 'degraded'
      throw new SessionError('Session message history could not be read.', 503)
    }
  }
}

function isValidSession(value: unknown): value is StreamSession {
  return isRecord(value) && typeof value.id === 'string' && typeof value.streamId === 'string' && typeof value.broadcasterId === 'string' &&
    typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) &&
    (value.endedAt === null || (typeof value.endedAt === 'string' && Number.isFinite(Date.parse(value.endedAt)))) &&
    (value.supersededAt === undefined || value.supersededAt === null || (typeof value.supersededAt === 'string' && Number.isFinite(Date.parse(value.supersededAt)))) &&
    (value.status === 'active' || value.status === 'completed' || value.status === 'interrupted') &&
    (value.captureComplete === undefined || typeof value.captureComplete === 'boolean') &&
    typeof value.totalMessages === 'number' && Number.isInteger(value.totalMessages) && value.totalMessages >= 0 && Array.isArray(value.uniqueViewerIds) &&
    isRecord(value.questionStatuses) && Object.values(value.questionStatuses).every((status) => status === 'open' || status === 'answered' || status === 'follow_up' || status === 'unanswered') && (value.questionPriorities === undefined || (isRecord(value.questionPriorities) && Object.values(value.questionPriorities).every((priority) => priority === 0 || priority === 1 || priority === 2))) && (value.analysis === null || isRecord(value.analysis)) && (value.communityPulse === undefined || value.communityPulse === null || isRecord(value.communityPulse))
}

export function calculateSessionMetrics(session: StreamSession, messages: SessionMessage[], polls: Array<{ status: string; startedAt: string | null; endedAt: string | null; totalVotes: number; options: Array<{ id: string; text: string; votes: number }> }>) {
  const questions = groupSessionQuestions(session, messages)
  const resolved = questions.map((question) => ({ ...question, status: question.status === 'open' ? 'unanswered' : question.status }))
  const uniqueMessageIds = new Set(messages.map((message) => message.messageId))
  const uniqueViewerIds = new Set(messages.flatMap((message) => message.chatterUserId ? [message.chatterUserId] : []))
  const sessionCutoff = session.endedAt ?? session.supersededAt
  const relevantPolls = polls.filter((poll) => poll.startedAt && Date.parse(poll.startedAt) >= Date.parse(session.startedAt) && (sessionCutoff === null || sessionCutoff === undefined || Date.parse(poll.startedAt) < Date.parse(sessionCutoff)))
  return {
    totalMessages: uniqueMessageIds.size,
    uniqueViewers: uniqueViewerIds.size,
    totalQuestions: resolved.length,
    answeredQuestions: resolved.filter((item) => item.status === 'answered').length,
    unansweredQuestions: resolved.filter((item) => item.status === 'unanswered').length,
    repeatedQuestions: resolved.filter((item) => item.messageIds.length > 1).length,
    questions: resolved.map(({ id, text, messageIds, status, priority }) => ({ id, text, count: messageIds.length, status, priority })),
    pollCount: relevantPolls.length,
    totalVotes: relevantPolls.reduce((sum, poll) => sum + poll.totalVotes, 0),
    polls: relevantPolls.map((poll) => ({ status: poll.status, totalVotes: poll.totalVotes, options: poll.options.map(({ id, text, votes }) => ({ id, text, votes })) })),
  }
}

function groupSessionQuestions(session: StreamSession, messages: SessionMessage[]): SessionQuestion[] {
  const groups = new Map<string, SessionQuestion>()
  const authorSets = new Map<string, Set<string>>()
  const seen = new Set<string>()
  for (const message of [...messages].sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp))) {
    if (seen.has(message.messageId) || !detectLikelyQuestion(message.text)) continue
    seen.add(message.messageId)
    const key = message.text.normalize('NFKC').replace(/\s+/gu, ' ').replace(/[.!?,;:…]+$/u, '').trim().toLocaleLowerCase('en-US')
    if (!key) continue
    const id = `q:${session.broadcasterId}:${session.id}:${key}`
    const group = groups.get(id) ?? { id, text: message.text.trim(), messageIds: [], authors: [], firstSeenAt: message.timestamp, lastSeenAt: message.timestamp, status: session.questionStatuses[id] ?? (session.questionStatuses[`live:${key}`] === 'answered' ? 'answered' : 'open'), priority: session.questionPriorities?.[id] ?? 0 }
    group.messageIds.push(message.messageId); group.lastSeenAt = message.timestamp
    const authorSet = authorSets.get(id) ?? new Set<string>(); const authorKey = message.chatterName.toLocaleLowerCase('en-US')
    if (authorKey && !authorSet.has(authorKey)) { authorSet.add(authorKey); group.authors.push(message.chatterName) }
    authorSets.set(id, authorSet); groups.set(id, group)
  }
  return [...groups.values()]
}

/** Mirrors the frontend's explainable question heuristic for persisted recap counts. */
function detectLikelyQuestion(text: string): boolean {
  const normalized = text.normalize('NFKC').trim()
  if (!normalized || /^(?:!|\/)\S+/u.test(normalized)) return false
  const trimmed = normalized.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ').replace(/\s+/gu, ' ').trim()
  if (!trimmed || (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false
  const wordsOnly = trimmed.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []
  if (wordsOnly.length > 0 && wordsOnly.every((word) => ['kappa', 'kekw', 'lul', 'pog', 'poggers', 'residentsleeper', 'widepeepohappy'].includes(word))) return false
  if (/^is this game (?:even )?real(?: lol)?[?!\.]*$/iu.test(trimmed) || /^is (?:anyone|anybody|everyone|someone)\b/iu.test(trimmed) || /^(?:anyone|anybody) (?:here|in chat)\b/iu.test(trimmed)) return false
  if (!trimmed) return false
  if (/[?？]/u.test(trimmed)) return true
  if (/^(?:cu[aá]ndo|d[oó]nde|qui[eé]n|cu[aá]l|c[oó]mo|quanto|quando|onde|qual|por que|qu[eé]\s+(?:es|hace|pas[oó]|significa|build|juego)\b)/iu.test(trimmed) || /^(?:est-ce que|pourquoi|quand|o[uù]|qui|comment|quel(?:le)?|tu\s+(?:joues|utilises|regardes|fais)\b)/iu.test(trimmed) || /(?:ですか|ますか|はいつ|はどこ|は何|いつですか|どこですか|何ですか)$/u.test(trimmed)) return true
  if (/^(?:is|are|was|were|do|does|did|can|could|will|would|should|has|have|had)\s+(?:(?:the|this|that|your|my|their|his|her)\s+)?[\p{L}][\p{L}'’-]*\s+(?:weak|strong|safe|possible|available|open|closed|effective|good|bad|better|worth|working|live|ready|immune|vulnerable|effective|resistant|real)\b/iu.test(trimmed)) return true
  if (/^(?:anyone know|does anyone know|do you know|could you tell me|can you tell me|can someone|could someone|any idea|is there|are there|what about|how about)\b/iu.test(trimmed) || AUXILIARY_START.test(trimmed)) return true
  const match = trimmed.match(WH_WORD)
  if (!match) return false
  const word = match[1]!.toLocaleLowerCase('en-US')
  const rest = trimmed.slice(match[0].length).trim()
  const words = rest.split(/\s+/u)
  const second = words[0]?.replace(/^["'“‘([{]+/u, '').toLocaleLowerCase('en-US')
  if (word === 'what' && (second === 'a' || second === 'an')) return false
  if (word === 'how' && second && HOW_EXCLAMATION_WORDS.has(second)) return false
  if (HELPER_WORD.test(rest)) return true
  if (word === 'how' && second && HOW_QUESTION_CUES.has(second)) return true
  const third = words[1]?.toLocaleLowerCase('en-US')
  if (words.length >= 2 && third && HELPER_WORD.test(third)) return true
  return Boolean(second && QUESTION_NOUNS.has(second))
}
