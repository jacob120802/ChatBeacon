import type { Poll, VoteReceipt } from './pollService.js'

export function formatPollAnnouncement(poll: Pick<Poll, 'question' | 'options'>): string {
  const choices = poll.options.map((option, index) => `${index + 1}) ${option.text}`).join(' · ')
  const text = `📊 ${poll.question} | ${choices} | Vote with !vote 1-${poll.options.length}`
  return Array.from(text).slice(0, 490).join('')
}

export function formatVoteReply(receipt: VoteReceipt): string | null {
  if (receipt.result === 'accepted' && receipt.selectedOption) return `Vote counted for ${receipt.selectedOption.text}.`
  if (receipt.result === 'updated' && receipt.selectedOption) return `Your vote is now ${receipt.selectedOption.text}.`
  if (receipt.result === 'unchanged' && receipt.selectedOption) return `Your vote for ${receipt.selectedOption.text} is already counted.`
  if (receipt.result === 'invalid_option' && receipt.poll) return `Vote not counted. Use !vote 1-${receipt.poll.options.length}.`
  if (receipt.result === 'poll_closed') return 'This poll is closed; new votes are not counted.'
  if (receipt.result === 'no_active_poll') return 'There is no active poll right now.'
  return null
}

export class ChatReplyLimiter {
  private lastGlobalReplyAt = Number.NEGATIVE_INFINITY
  private readonly lastViewerReplyAt = new Map<string, number>()

  constructor(private readonly globalCooldownMs = 2_000, private readonly viewerCooldownMs = 10_000, private readonly maxTrackedViewers = 500) {}

  reserve(viewerId: string, now: number): boolean {
    const previousViewerReply = this.lastViewerReplyAt.get(viewerId)
    if (now - this.lastGlobalReplyAt < this.globalCooldownMs ||
      (previousViewerReply !== undefined && now - previousViewerReply < this.viewerCooldownMs)) return false
    this.lastGlobalReplyAt = now
    this.lastViewerReplyAt.delete(viewerId)
    this.lastViewerReplyAt.set(viewerId, now)
    if (this.lastViewerReplyAt.size > this.maxTrackedViewers) {
      const oldestViewer = this.lastViewerReplyAt.keys().next().value
      if (oldestViewer) this.lastViewerReplyAt.delete(oldestViewer)
    }
    return true
  }
}
