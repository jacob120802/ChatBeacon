export type ChatMessage = {
  messageId: string
  timestamp: string
  chatterName: string
  text: string
}

/** Internal EventSub fields used for channel-scoped voting; never returned by the chat API. */
export type ChatNotification = ChatMessage & {
  chatterUserId?: string | null
  broadcasterUserId?: string | null
}

export class RecentChatMessages {
  private readonly recent: ChatMessage[] = []
  private readonly seenIds = new Set<string>()
  private readonly seenOrder: string[] = []

  constructor(
    private readonly messageLimit = 100,
    private readonly deduplicationLimit = 5_000,
  ) {}

  add(message: ChatNotification): boolean {
    if (this.seenIds.has(message.messageId)) return false

    this.seenIds.add(message.messageId)
    this.seenOrder.push(message.messageId)
    if (this.seenOrder.length > this.deduplicationLimit) {
      const oldestId = this.seenOrder.shift()
      if (oldestId) this.seenIds.delete(oldestId)
    }

    this.recent.unshift({
      messageId: message.messageId,
      timestamp: message.timestamp,
      chatterName: message.chatterName,
      text: message.text,
    })
    if (this.recent.length > this.messageLimit) this.recent.pop()
    return true
  }

  getAll(): ChatMessage[] {
    return this.recent.map((message) => ({ ...message }))
  }

  clear(): void {
    this.recent.length = 0
    this.seenOrder.length = 0
    this.seenIds.clear()
  }

  get size(): number {
    return this.recent.length
  }
}
