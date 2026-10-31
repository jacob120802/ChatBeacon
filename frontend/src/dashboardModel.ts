export const dashboardNavigation = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat-tracker', label: 'Chat Tracker' },
  { id: 'community-pulse', label: 'Community Pulse' },
  { id: 'beacon-pulse', label: 'Beacon Pulse' },
  { id: 'stream-recap', label: 'Stream Recap' },
] as const

export type DashboardOverviewInput = {
  live: boolean
  pendingQuestions: number
  communityAnalysisReady: boolean
  pollStatus: 'none' | 'draft' | 'active' | 'closed'
  pollVotes: number
  sessionCount: number
  sessionActive: boolean
}

export function buildOverviewTiles(input: DashboardOverviewInput) {
  return [
    {
      id: 'questions',
      label: 'Questions to answer',
      value: String(input.pendingQuestions),
      detail: input.pendingQuestions === 1 ? '1 question is waiting' : `${input.pendingQuestions} questions are waiting`,
      href: '#chat-tracker',
    },
    {
      id: 'community',
      label: 'Community Pulse',
      value: input.communityAnalysisReady ? 'Insights ready' : input.live ? 'Ready to analyze' : 'Waiting for chat',
      detail: input.communityAnalysisReady ? 'Review or refresh recent insights' : 'Analyze only when you choose',
      href: '#community-pulse',
    },
    {
      id: 'poll',
      label: 'Beacon Pulse',
      value: input.pollStatus === 'none' ? 'No poll yet' : `Poll ${input.pollStatus}`,
      detail: input.pollStatus === 'active' ? `${input.pollVotes} valid votes so far` : 'Create or review a chat poll',
      href: '#beacon-pulse',
    },
    {
      id: 'recap',
      label: 'Stream Recap',
      value: input.sessionCount === 0 ? 'No sessions yet' : `${input.sessionCount} ${input.sessionCount === 1 ? 'session' : 'sessions'}`,
      detail: input.sessionActive ? 'A stream session is in progress' : 'Review saved stream sessions',
      href: '#stream-recap',
    },
  ] as const
}

export function getPollOverlayUrl(origin: string): string {
  const url = new URL(origin)
  url.port = '3001'
  url.pathname = '/poll-overlay'
  url.search = ''
  url.hash = ''
  return url.toString()
}
