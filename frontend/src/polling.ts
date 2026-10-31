export type SavedPoll = {
  id: string
  question: string
  options: { id: string; text: string; votes: number }[]
  status: 'draft' | 'active' | 'closed'
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  totalVotes: number
}

export type VoteStatus = {
  status: 'draft' | 'active' | 'closed' | 'none'
  totalVotes: number
  voteFeedback: { kind: 'invalid_option' | 'poll_closed'; pollId: string; timestamp: string } | null
  chatAnnouncement: { pollId: string; result: 'sent' | 'permission_required' | 'failed' } | null
}

export function updateDraftPollQuestion(poll: SavedPoll | null, question: string): SavedPoll | null {
  return poll?.status === 'draft' ? { ...poll, question } : poll
}

export function isValidPollInput(question: string, options: string[]): boolean {
  const normalized = options.map((option) => option.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))
  return question.trim().length >= 5 && question.trim().length <= 140 &&
    options.length >= 2 && options.length <= 4 && options.every((option) => option.trim().length > 0 && option.trim().length <= 60) &&
    new Set(normalized).size === normalized.length
}

export function parseSavedPoll(value: unknown): SavedPoll | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const poll = value as Record<string, unknown>
  if (typeof poll.id !== 'string' || typeof poll.question !== 'string' ||
    (poll.status !== 'draft' && poll.status !== 'active' && poll.status !== 'closed') ||
    !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 4 ||
    !poll.options.every((option) => Boolean(option && typeof option === 'object' &&
      typeof option.id === 'string' && typeof option.text === 'string' && typeof option.votes === 'number')) ||
    typeof poll.createdAt !== 'string' || !(poll.startedAt === null || typeof poll.startedAt === 'string') ||
    !(poll.endedAt === null || typeof poll.endedAt === 'string') || typeof poll.totalVotes !== 'number') return undefined
  return poll as unknown as SavedPoll
}

export function parseVoteStatus(value: unknown): VoteStatus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const status = value as Record<string, unknown>
  if ((status.status !== 'draft' && status.status !== 'active' && status.status !== 'closed' && status.status !== 'none') ||
    typeof status.totalVotes !== 'number' || !Number.isInteger(status.totalVotes) || status.totalVotes < 0) return undefined
  if (status.voteFeedback !== null) {
    if (!status.voteFeedback || typeof status.voteFeedback !== 'object') return undefined
    const feedback = status.voteFeedback as Record<string, unknown>
    if ((feedback.kind !== 'invalid_option' && feedback.kind !== 'poll_closed') || typeof feedback.pollId !== 'string' ||
      typeof feedback.timestamp !== 'string' || !Number.isFinite(Date.parse(feedback.timestamp))) return undefined
  }
  if (status.chatAnnouncement !== null) {
    if (!status.chatAnnouncement || typeof status.chatAnnouncement !== 'object') return undefined
    const announcement = status.chatAnnouncement as Record<string, unknown>
    if (typeof announcement.pollId !== 'string' ||
      (announcement.result !== 'sent' && announcement.result !== 'permission_required' && announcement.result !== 'failed')) return undefined
  }
  return status as unknown as VoteStatus
}
