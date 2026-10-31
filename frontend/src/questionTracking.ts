export type QuestionStatus = 'unanswered' | 'answered' | 'follow_up'

export type QuestionMessage = {
  messageId: string
  timestamp: string
  chatterName: string
  text: string
}

export type TrackedQuestion = {
  id: string
  normalizedText: string
  text: string
  messageIds: string[]
  authors: string[]
  firstSeenAt: string
  lastSeenAt: string
  status: QuestionStatus
  manualPriority: 0 | 1 | 2
  priorityScore: number
}

export type QuestionStatusMap = Record<string, QuestionStatus | 'open'>
export type QuestionPriorityMap = Record<string, 0 | 1 | 2>

export function questionPriorityScore(question: Pick<TrackedQuestion, 'authors' | 'lastSeenAt' | 'manualPriority' | 'status'>, now = Date.now()): number {
  if (question.status === 'answered') return -1
  const distinctViewerPoints = Math.min(question.authors.length, 5) * 10
  const recencyPoints = Math.max(0, 20 - Math.max(0, now - Date.parse(question.lastSeenAt)) / 3_600_000)
  const followUpPoints = question.status === 'follow_up' ? 15 : 0
  return question.manualPriority * 100 + followUpPoints + distinctViewerPoints + recencyPoints
}

export function sortQuestionsByPriority<T extends Pick<TrackedQuestion, 'priorityScore' | 'firstSeenAt' | 'id'>>(questions: T[]): T[] {
  return [...questions].sort((a, b) => b.priorityScore - a.priorityScore || Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || a.id.localeCompare(b.id))
}

const QUESTION_PHRASES = /^(?:anyone know|does anyone know|do you know|could you tell me|can you tell me|can someone|could someone|any idea|is there|are there|what about|how about)\b/i
const AUXILIARY_START = /^(?:can|could|would|will|should|do|does|did|is|are|was|were|have|has|had|may|might)\s+(?:i|we|you|they|he|she|it|there|anyone|someone|somebody|anybody)\b/i
const WH_WORD = /^(what|when|where|who|whom|whose|why|which|how)\b/i
const HELPER_WORD = /^(?:is|are|was|were|do|does|did|can|could|would|will|should|have|has|had|might|may)\b/i
const QUESTION_NOUNS = new Set([
  'about', 'app', 'build', 'character', 'channel', 'class', 'country', 'date', 'day', 'episode',
  'else', 'game', 'happened', 'item', 'keyboard', 'level', 'map', 'name', 'next', 'platform', 'price',
  'said', 'song', 'stream', 'time', 'to', 'weapon', 'who', 'why', 'won',
])
const HOW_QUESTION_CUES = new Set([
  'about', 'are', 'can', 'come', 'could', 'did', 'do', 'does', 'far', 'is', 'long', 'many',
  'might', 'much', 'often', 'old', 'should', 'to', 'was', 'were', 'will', 'would',
])
const HOW_EXCLAMATION_WORDS = new Set([
  'amazing', 'awesome', 'beautiful', 'cool', 'fun', 'funny', 'great', 'lovely', 'nice',
  'strange', 'terrible', 'weird', 'wonderful',
])
const NON_ACTIONABLE_EMOTES = new Set(['kappa', 'kekw', 'lul', 'pog', 'poggers', 'residentsleeper', 'widepeepohappy'])
const RHETORICAL_PHRASES = [/^is this game (?:even )?real(?: lol)?[?!\.]*$/iu]
const CHAT_AUDIENCE_QUESTIONS = [/^is (?:anyone|anybody|everyone|someone)\b/iu, /^(?:anyone|anybody) (?:here|in chat)\b/iu]
const MULTILINGUAL_QUESTION_START = /^(?:cu[aá]ndo|d[oó]nde|qui[eé]n|cu[aá]l|c[oó]mo|quanto|quando|onde|qual|por que|qu[eé]\s+(?:es|hace|pas[oó]|significa|build|juego)\b)/iu
const FRENCH_QUESTION_START = /^(?:est-ce que|pourquoi|quand|o[uù]|qui|comment|quel(?:le)?|tu\s+(?:joues|utilises|regardes|fais)\b)/iu
const JAPANESE_QUESTION_END = /(?:ですか|ますか|はいつ|はどこ|は何|いつですか|どこですか|何ですか)$/u
const INVERTED_QUESTION = /^(?:is|are|was|were|do|does|did|can|could|will|would|should|has|have|had)\s+(?:(?:the|this|that|your|my|their|his|her)\s+)?[\p{L}][\p{L}'’-]*\s+(?:weak|strong|safe|possible|available|open|closed|effective|good|bad|better|worth|working|live|ready|immune|vulnerable|effective|resistant|real)\b/iu

/**
 * A small, explainable heuristic. A question mark is a strong cue; otherwise
 * the message must begin with a recognizable question phrase or structure.
 */
export function detectLikelyQuestion(text: string): boolean {
  const normalized = text.normalize('NFKC').trim()
  if (!normalized || /^(?:!|\/)\S+/u.test(normalized)) return false
  // A URL may contain `?` as part of its query string; only inspect the chat text around it.
  const trimmed = normalized.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ').replace(/\s+/gu, ' ').trim()
  if (!trimmed) return false
  if ((trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false
  const bareTokens = trimmed.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []
  if (bareTokens.length > 0 && bareTokens.every((token) => NON_ACTIONABLE_EMOTES.has(token))) return false
  if (RhetoricalPhrase(trimmed) || CHAT_AUDIENCE_QUESTIONS.some((pattern) => pattern.test(trimmed))) return false
  if (/[?？]/u.test(trimmed)) return true
  if (MULTILINGUAL_QUESTION_START.test(trimmed) || FRENCH_QUESTION_START.test(trimmed) || JAPANESE_QUESTION_END.test(trimmed)) return true
  if (INVERTED_QUESTION.test(trimmed)) return true
  if (QUESTION_PHRASES.test(trimmed) || AUXILIARY_START.test(trimmed)) return true

  const whMatch = trimmed.match(WH_WORD)
  if (!whMatch) return false
  const whWord = whMatch[1].toLocaleLowerCase('en-US')
  const rest = trimmed.slice(whMatch[0].length).trim()
  const words = rest.split(/\s+/u)
  const secondWord = words[0]?.replace(/^["'“‘([{]+/u, '').toLocaleLowerCase('en-US')

  // “What a great run!” and “How beautiful!” are usually exclamations.
  if (whWord === 'what' && (secondWord === 'a' || secondWord === 'an')) return false
  if (whWord === 'how' && secondWord && HOW_EXCLAMATION_WORDS.has(secondWord)) return false

  if (HELPER_WORD.test(rest)) return true
  if (whWord === 'how' && secondWord && HOW_QUESTION_CUES.has(secondWord)) return true

  const thirdWord = words[1]?.toLocaleLowerCase('en-US')
  if (words.length >= 2 && thirdWord && HELPER_WORD.test(thirdWord)) return true
  return Boolean(secondWord && QUESTION_NOUNS.has(secondWord))
}

function RhetoricalPhrase(text: string): boolean {
  return RHETORICAL_PHRASES.some((pattern) => pattern.test(text))
}

const EVENT_TOPIC_FAMILIES = new Map([
  ['tournament', 'tournament'], ['tournaments', 'tournament'], ['torneo', 'tournament'], ['torneos', 'tournament'], ['competition', 'tournament'], ['competitions', 'tournament'], ['event', 'tournament'], ['events', 'tournament'],
  ['stream', 'stream'], ['streams', 'stream'], ['live', 'stream'], ['配信', 'stream'],
])
const EVENT_TIMING_WORDS = new Set(['when', 'next', 'soon', 'update', 'hosting', 'host', 'schedule', 'again', 'another', 'coming', 'cuando', 'empieza', 'proxima', 'otra', 'vez', 'when'])

function relatedQuestionScope(id: string): string {
  return id.startsWith('q:') ? id.split(':').slice(0, 3).join(':') : id.split(':', 1)[0] ?? ''
}

/** Suggest likely event-schedule paraphrases without changing IDs, counts, or saved status. */
export function findRelatedQuestionSuggestions(questions: Pick<TrackedQuestion, 'id' | 'normalizedText'>[]): Map<string, string[]> {
  const related = new Map<string, string[]>()
  const rows = questions.map((question) => {
    const folded = question.normalizedText.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('en-US')
    const words = new Set(folded.match(/[\p{L}\p{N}]+/gu) ?? [])
    const eventFamily = [...words].map((word) => EVENT_TOPIC_FAMILIES.get(word)).find(Boolean)
    const eventSchedule = Boolean(eventFamily && [...words].some((word) => EVENT_TIMING_WORDS.has(word)))
    return { ...question, eventFamily, eventSchedule }
  })
  for (let first = 0; first < rows.length; first += 1) {
    for (let second = first + 1; second < rows.length; second += 1) {
      const a = rows[first]!
      const b = rows[second]!
      if (!a.eventSchedule || !b.eventSchedule || a.eventFamily !== b.eventFamily || relatedQuestionScope(a.id) !== relatedQuestionScope(b.id)) continue
      related.set(a.id, [...(related.get(a.id) ?? []), b.id])
      related.set(b.id, [...(related.get(b.id) ?? []), a.id])
    }
  }
  return related
}

/** Lowercase, collapse whitespace, and ignore only punctuation at the end. */
export function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?,;:…]+$/u, '')
    .trim()
    .toLocaleLowerCase('en-US')
}

export function questionIdFor(source: 'demo' | 'live', normalizedText: string): string {
  return `${source}:${normalizedText}`
}

/** Merge overlapping polling snapshots, retaining a bounded chronological history. */
export function mergeChatHistory(
  previous: QuestionMessage[],
  incoming: QuestionMessage[],
  historyLimit = 1_000,
): QuestionMessage[] {
  const byId = new Map<string, QuestionMessage>()
  for (const message of previous) {
    if (message.messageId) byId.set(message.messageId, message)
  }

  let addedMessage = false
  for (const message of incoming) {
    if (!message.messageId || byId.has(message.messageId)) continue
    byId.set(message.messageId, message)
    addedMessage = true
  }
  if (!addedMessage) return previous

  return [...byId.values()]
    .sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp) || first.messageId.localeCompare(second.messageId))
    .slice(-historyLimit)
}

/** Group only exact normalized text matches; message IDs make polling idempotent. */
export function groupQuestions(
  messages: QuestionMessage[],
  statuses: QuestionStatusMap = {},
  source: 'demo' | 'live' = 'live',
  scope?: { broadcasterId: string; sessionId: string },
  priorities: QuestionPriorityMap = {},
): TrackedQuestion[] {
  const orderedMessages = [...messages]
    .filter((message) => message.messageId && Number.isFinite(Date.parse(message.timestamp)))
    .sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp) || first.messageId.localeCompare(second.messageId))

  const seenMessageIds = new Set<string>()
  const groups = new Map<string, {
    id: string
    normalizedText: string
    text: string
    messageIds: string[]
    authors: string[]
    authorKeys: Set<string>
    firstSeenAt: string
    lastSeenAt: string
  }>()

  for (const message of orderedMessages) {
    if (seenMessageIds.has(message.messageId)) continue
    seenMessageIds.add(message.messageId)
    if (!detectLikelyQuestion(message.text)) continue

    const normalizedText = normalizeQuestionText(message.text)
    if (!normalizedText) continue
    const id = scope ? `q:${scope.broadcasterId}:${scope.sessionId}:${normalizedText}` : questionIdFor(source, normalizedText)
    let group = groups.get(id)
    if (!group) {
      group = {
        id,
        normalizedText,
        text: message.text.trim(),
        messageIds: [],
        authors: [],
        authorKeys: new Set<string>(),
        firstSeenAt: message.timestamp,
        lastSeenAt: message.timestamp,
      }
      groups.set(id, group)
    }

    group.messageIds.push(message.messageId)
    group.lastSeenAt = message.timestamp
    const author = message.chatterName.trim()
    const authorKey = author.toLocaleLowerCase('en-US')
    if (author && !group.authorKeys.has(authorKey)) {
      group.authorKeys.add(authorKey)
      group.authors.push(author)
    }
  }

  return sortQuestionsByPriority([...groups.values()].map(({ authorKeys: _authorKeys, ...group }) => {
    const savedStatus = statuses[group.id]
    const manualPriority = priorities[group.id] ?? 0
    const question = { ...group, manualPriority, status: savedStatus === 'open' || !savedStatus ? 'unanswered' : savedStatus }
    return { ...question, priorityScore: questionPriorityScore(question) }
  }))
}
