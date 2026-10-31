import { randomUUID } from 'node:crypto'
import { JsonPollStore, type PollRepository } from './pollStore.js'

export type PollStatus = 'draft' | 'active' | 'closed'

export type PollOption = {
  id: string
  text: string
  votes: number
}

export type Poll = {
  id: string
  question: string
  options: PollOption[]
  status: PollStatus
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  totalVotes: number
  broadcasterId: string
  /** Private voter ID -> option ID mapping. Never return this from an API. */
  voterSelections: Record<string, string>
  /** Twitch EventSub timestamp of each voter's latest accepted vote. */
  voterSelectionTimestamps: Record<string, string>
  /** Persisted Twitch EventSub IDs make reconnect/replay deliveries idempotent. */
  processedVoteMessageIds: string[]
}

export type PublicPoll = Omit<Poll, 'broadcasterId' | 'voterSelections' | 'voterSelectionTimestamps' | 'processedVoteMessageIds'>

export function toPublicPoll(poll: Poll): PublicPoll {
  const { broadcasterId: _broadcasterId, voterSelections: _voters, voterSelectionTimestamps: _timestamps, processedVoteMessageIds: _eventIds, ...publicPoll } = poll
  return publicPoll
}

export type VoteResult = 'accepted' | 'updated' | 'unchanged' | 'duplicate' | 'out_of_order' | 'outside_poll_window' | 'invalid_option' | 'no_active_poll' | 'poll_closed'
export type VoteFeedback = { kind: 'invalid_option' | 'poll_closed'; pollId: string; timestamp: string } | null
export type VoteReceipt = { result: VoteResult; poll: Poll | null; selectedOption: PollOption | null }
export type ChatAnnouncementFeedback = { pollId: string; result: 'sent' | 'permission_required' | 'failed' } | null

export type ParsedVoteCommand = { kind: 'vote'; optionNumber: number } | { kind: 'invalid' }

export function parseVoteCommand(text: string): ParsedVoteCommand | null {
  if (!/^\s*!vote\b/iu.test(text)) return null
  const match = /^\s*!vote\s+(\d+)\s*$/iu.exec(text)
  if (!match) return { kind: 'invalid' }
  const optionNumber = Number(match[1])
  return Number.isSafeInteger(optionNumber) ? { kind: 'vote', optionNumber } : { kind: 'invalid' }
}

export class PollError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

export class PollStorageError extends Error {
  readonly statusCode = 503
  constructor() {
    super('Poll storage could not be accessed. Check that backend/data is available and writable, then restart the backend.')
  }
}

type PollClock = () => Date
type IdFactory = () => string

function validateQuestion(value: unknown): string {
  if (typeof value !== 'string') throw new PollError('Enter a poll question.')
  const question = value.trim()
  if (question.length < 5 || question.length > 140) throw new PollError('A poll question must be 5 to 140 characters long.')
  return question
}

function validateOptions(value: unknown, existing?: PollOption[]): PollOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new PollError('A poll must have between two and four answer options.')
  }
  const texts = value.map((option) => {
    if (typeof option !== 'string') throw new PollError('Each poll option must be text.')
    const text = option.trim()
    if (!text || text.length > 60) throw new PollError('Poll options must be 1 to 60 characters long.')
    return text
  })
  const normalized = texts.map((text) => text.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))
  if (new Set(normalized).size !== normalized.length) throw new PollError('Poll options must be different from one another.')
  return texts.map((text, index) => ({ id: existing?.[index]?.id ?? randomUUID(), text, votes: 0 }))
}

function requireBroadcaster(value: string): string {
  if (!value || value.length > 100) throw new PollError('Connect Twitch before managing polls.', 401)
  return value
}

/** Parse RFC3339 precision without Date.parse's millisecond truncation. */
function timestampNanoseconds(value: string): bigint | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/u.exec(value)
  if (!match) return null
  const epochMilliseconds = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(epochMilliseconds)) return null
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9)
  return BigInt(epochMilliseconds) * 1_000_000n + BigInt(fraction || '0')
}

export class PollService {
  private polls: Poll[] | null = null
  private operation: Promise<void> = Promise.resolve()
  private readonly voteFeedback = new Map<string, VoteFeedback>()
  private readonly announcementFeedback = new Map<string, ChatAnnouncementFeedback>()

  constructor(
    private readonly repository: PollRepository = new JsonPollStore(),
    private readonly now: PollClock = () => new Date(),
    private readonly makeId: IdFactory = randomUUID,
  ) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async ensureLoaded(): Promise<Poll[]> {
    if (!this.polls) {
      try { this.polls = await this.repository.load() } catch { throw new PollStorageError() }
    }
    return this.polls
  }

  private async save(nextPolls: Poll[]): Promise<void> {
    try { await this.repository.save(nextPolls) } catch { throw new PollStorageError() }
    this.polls = nextPolls
  }

  async createDraft(broadcasterId: string, input: { question: unknown; options: unknown }): Promise<Poll> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const poll: Poll = {
        id: this.makeId(),
        question: validateQuestion(input.question),
        options: validateOptions(input.options),
        status: 'draft',
        createdAt: this.now().toISOString(),
        startedAt: null,
        endedAt: null,
        totalVotes: 0,
        broadcasterId: broadcaster,
        voterSelections: {},
        voterSelectionTimestamps: {},
        processedVoteMessageIds: [],
      }
      const polls = await this.ensureLoaded()
      await this.save([...polls, poll])
      return structuredClone(poll)
    })
  }

  async editDraft(broadcasterId: string, pollId: string, input: { question: unknown; options: unknown }): Promise<Poll> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const existing = polls.find((poll) => poll.id === pollId && poll.broadcasterId === broadcaster)
      if (!existing) throw new PollError('Poll not found.', 404)
      if (existing.status !== 'draft') throw new PollError('Only a draft poll can be edited.', 409)
      const updated: Poll = {
        ...existing,
        question: validateQuestion(input.question),
        options: validateOptions(input.options, existing.options),
      }
      await this.save(polls.map((poll) => poll.id === pollId ? updated : poll))
      return structuredClone(updated)
    })
  }

  async activate(broadcasterId: string, pollId: string): Promise<Poll> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const existing = polls.find((poll) => poll.id === pollId && poll.broadcasterId === broadcaster)
      if (!existing) throw new PollError('Poll not found.', 404)
      if (existing.status !== 'draft') throw new PollError('Only a draft poll can be activated.', 409)
      if (polls.some((poll) => poll.broadcasterId === broadcaster && poll.status === 'active')) {
        throw new PollError('Close the active poll before activating another one.', 409)
      }
      const activated: Poll = { ...existing, status: 'active', startedAt: this.now().toISOString() }
      await this.save(polls.map((poll) => poll.id === pollId ? activated : poll))
      return structuredClone(activated)
    })
  }

  async close(broadcasterId: string, pollId: string): Promise<Poll> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const existing = polls.find((poll) => poll.id === pollId && poll.broadcasterId === broadcaster)
      if (!existing) throw new PollError('Poll not found.', 404)
      if (existing.status !== 'active') throw new PollError('Only an active poll can be closed.', 409)
      const closed: Poll = { ...existing, status: 'closed', endedAt: this.now().toISOString() }
      await this.save(polls.map((poll) => poll.id === pollId ? closed : poll))
      return structuredClone(closed)
    })
  }

  async recordVote(broadcasterId: string, chatterUserId: string, messageId: string, optionNumber: number, eventTimestamp: string): Promise<VoteReceipt> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      if (!chatterUserId || chatterUserId.length > 100 || !messageId || messageId.length > 200) return { result: 'invalid_option', poll: null, selectedOption: null }
      const polls = await this.ensureLoaded()
      const channelPolls = polls.filter((poll) => poll.broadcasterId === broadcaster)
      const active = channelPolls.find((poll) => poll.status === 'active')
      const eventTime = timestampNanoseconds(eventTimestamp)
      if (eventTime === null) return { result: 'outside_poll_window', poll: null, selectedOption: null }
      // EventSub can redeliver notifications. Route by Twitch's original envelope
      // timestamp, not by when this process happens to receive the message.
      const target = channelPolls
        .filter((poll) => poll.status !== 'draft' && poll.startedAt && eventTime >= timestampNanoseconds(poll.startedAt)! &&
          (poll.endedAt === null || eventTime <= timestampNanoseconds(poll.endedAt)!))
        .sort((first, second) => Date.parse(second.startedAt!) - Date.parse(first.startedAt!))[0]
      if (!target) {
        if (active?.startedAt && eventTime < timestampNanoseconds(active.startedAt)!) return { result: 'outside_poll_window', poll: structuredClone(active), selectedOption: null }
        const latestClosed = [...channelPolls].filter((poll) => poll.status === 'closed' && poll.endedAt)
          .sort((first, second) => Date.parse(second.endedAt!) - Date.parse(first.endedAt!))[0]
        if (latestClosed?.endedAt && eventTime > timestampNanoseconds(latestClosed.endedAt)!) {
          this.voteFeedback.set(broadcaster, { kind: 'poll_closed', pollId: latestClosed.id, timestamp: this.now().toISOString() })
          return { result: 'poll_closed', poll: structuredClone(latestClosed), selectedOption: null }
        }
        return { result: active || !latestClosed ? 'no_active_poll' : 'outside_poll_window', poll: active ? structuredClone(active) : null, selectedOption: null }
      }
      if (!Number.isInteger(optionNumber) || optionNumber < 1 || optionNumber > target.options.length) {
        this.voteFeedback.set(broadcaster, { kind: 'invalid_option', pollId: target.id, timestamp: this.now().toISOString() })
        return { result: 'invalid_option', poll: structuredClone(target), selectedOption: null }
      }
      if (target.processedVoteMessageIds.includes(messageId)) return { result: 'duplicate', poll: structuredClone(target), selectedOption: null }

      const selectedOptionId = target.options[optionNumber - 1]!.id
      const previousOptionId = target.voterSelections[chatterUserId]
      const previousTimestamp = target.voterSelectionTimestamps[chatterUserId]
      const processedVoteMessageIds = [...target.processedVoteMessageIds, messageId]
      const previousTime = previousTimestamp ? timestampNanoseconds(previousTimestamp) : null
      // Equal timestamps are ambiguous; keep the first accepted selection instead of
      // allowing delivery order to decide which same-time command wins.
      if ((previousTimestamp && previousTime === null) || (previousTime !== null && eventTime <= previousTime) || (previousOptionId !== undefined && previousTimestamp === undefined)) {
        const reordered = {
          ...target,
          processedVoteMessageIds,
          ...(previousOptionId !== undefined && previousTimestamp === undefined
            ? { voterSelectionTimestamps: { ...target.voterSelectionTimestamps, [chatterUserId]: eventTimestamp } }
            : {}),
        }
        await this.save(polls.map((poll) => poll.id === target.id ? reordered : poll))
        return { result: 'out_of_order', poll: structuredClone(reordered), selectedOption: null }
      }
      const voterSelections = { ...target.voterSelections, [chatterUserId]: selectedOptionId }
      const voterSelectionTimestamps = { ...target.voterSelectionTimestamps, [chatterUserId]: eventTimestamp }
      const voteCounts = new Map<string, number>()
      for (const option of target.options) voteCounts.set(option.id, 0)
      for (const optionId of Object.values(voterSelections)) voteCounts.set(optionId, (voteCounts.get(optionId) ?? 0) + 1)
      const updated: Poll = {
        ...target,
        voterSelections,
        voterSelectionTimestamps,
        processedVoteMessageIds,
        options: target.options.map((option) => ({ ...option, votes: voteCounts.get(option.id) ?? 0 })),
        totalVotes: Object.keys(voterSelections).length,
      }
      await this.save(polls.map((poll) => poll.id === target.id ? updated : poll))
      const result = previousOptionId === undefined ? 'accepted' : previousOptionId === selectedOptionId ? 'unchanged' : 'updated'
      return { result, poll: structuredClone(updated), selectedOption: structuredClone(updated.options[optionNumber - 1]!) }
    })
  }

  async setAnnouncementFeedback(broadcasterId: string, pollId: string, result: 'sent' | 'permission_required' | 'failed'): Promise<void> {
    await this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      this.announcementFeedback.set(broadcaster, { pollId, result })
    })
  }

  async getActive(broadcasterId: string): Promise<Poll | null> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const active = polls.find((poll) => poll.broadcasterId === broadcaster && poll.status === 'active')
      return active ? structuredClone(active) : null
    })
  }

  async getResults(broadcasterId: string): Promise<Poll | null> {
    return this.getCurrent(broadcasterId)
  }

  async getOverlayPoll(broadcasterId: string): Promise<Poll | null> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const relevant = polls.filter((poll) => poll.broadcasterId === broadcaster)
      const active = relevant.find((poll) => poll.status === 'active')
      const latestClosed = [...relevant].filter((poll) => poll.status === 'closed')
        .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0]
      return structuredClone(active ?? latestClosed ?? null)
    })
  }

  async getStatus(broadcasterId: string): Promise<{ status: PollStatus | 'none'; totalVotes: number; voteFeedback: VoteFeedback; chatAnnouncement: ChatAnnouncementFeedback }> {
    const poll = await this.getCurrent(broadcasterId)
    const announcement = this.announcementFeedback.get(broadcasterId) ?? null
    return {
      status: poll?.status ?? 'none',
      totalVotes: poll?.totalVotes ?? 0,
      voteFeedback: this.voteFeedback.get(broadcasterId) ?? null,
      chatAnnouncement: announcement?.pollId === poll?.id ? announcement : null,
    }
  }

  async getCurrent(broadcasterId: string): Promise<Poll | null> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const matching = polls.filter((poll) => poll.broadcasterId === broadcaster)
      const recentFirst = [...matching].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
      const current = recentFirst.find((poll) => poll.status === 'active') ??
        recentFirst.find((poll) => poll.status === 'draft') ?? recentFirst[0] ?? null
      return current ? structuredClone(current) : null
    })
  }

  async getById(broadcasterId: string, pollId: string): Promise<Poll> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const poll = polls.find((item) => item.id === pollId && item.broadcasterId === broadcaster)
      if (!poll) throw new PollError('Poll not found.', 404)
      return structuredClone(poll)
    })
  }

  async listForBroadcaster(broadcasterId: string): Promise<Poll[]> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      return polls.filter((poll) => poll.broadcasterId === broadcaster).map((poll) => structuredClone(poll))
    })
  }

  async closeActiveForBroadcaster(broadcasterId: string, endedAt: string): Promise<Poll | null> {
    return this.exclusive(async () => {
      const broadcaster = requireBroadcaster(broadcasterId)
      const polls = await this.ensureLoaded()
      const active = polls.find((poll) => poll.broadcasterId === broadcaster && poll.status === 'active')
      if (!active) return null
      const time = Date.parse(endedAt)
      if (!Number.isFinite(time) || !active.startedAt || time < Date.parse(active.startedAt)) throw new PollError('The stream end time was invalid.')
      const closed: Poll = { ...active, status: 'closed', endedAt: new Date(time).toISOString() }
      await this.save(polls.map((poll) => poll.id === active.id ? closed : poll))
      return structuredClone(closed)
    })
  }
}
