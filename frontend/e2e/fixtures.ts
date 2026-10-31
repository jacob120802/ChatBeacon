import type { Page } from '@playwright/test'
import { groupQuestions } from '../src/questionTracking'

// Only synthetic records. No live Twitch requests, user storage, or real keys.
export const messages = [
  { messageId: 'fixture-1', timestamp: '2026-10-31T10:01:00Z', chatterName: 'DemoMira', text: 'What should we play next?' },
  { messageId: 'fixture-2', timestamp: '2026-10-31T10:02:00Z', chatterName: 'DemoPixel', text: 'WHAT should we play next?!' },
  { messageId: 'fixture-3', timestamp: '2026-10-31T10:03:00Z', chatterName: 'DemoLime', text: 'Will you stream tomorrow?' },
  { messageId: 'fixture-4', timestamp: '2026-10-31T10:04:00Z', chatterName: 'DemoRiver', text: 'I would enjoy a co-op challenge next stream.' },
]
export type FixturePoll = { id: string; question: string; options: { id: string; text: string; votes: number }[]; status: 'draft' | 'active' | 'closed'; createdAt: string; startedAt: string | null; endedAt: string | null; totalVotes: number }
export function makePoll(status: FixturePoll['status'] = 'closed'): FixturePoll {
  return { id: 'fixture-poll', question: 'Which challenge should we try next?', options: ['Co-op adventure', 'Solo speed run'].map((text, i) => ({ id: String(i + 1), text, votes: 0 })), status, createdAt: '2026-10-31T10:00:00Z', startedAt: status === 'draft' ? null : '2026-10-31T10:04:00Z', endedAt: status === 'closed' ? '2026-10-31T10:10:00Z' : null, totalVotes: 0 }
}
export async function setupDashboard(page: Page, options: { connected?: boolean; poll?: FixturePoll | null } = {}) {
  const state = {
    connected: options.connected ?? true,
    reconnecting: false, persistenceFailed: false, aiFailed: false, saveFailed: false,
    poll: options.poll ?? null, statuses: {} as Record<string, 'answered' | 'unanswered' | 'follow_up'>,
    priorities: {} as Record<string, 0 | 1 | 2>, completed: false,
    mutations: [] as { path: string; method: string; body: unknown }[],
  }
  const pulse = { insufficientData: false, overallSummary: 'Viewers are discussing what to play next and the next stream schedule.', topics: [{ title: 'The next game', explanation: 'Two messages ask about the next game.', messageIds: ['fixture-1', 'fixture-2'], representativeMessages: messages.slice(0, 2) }], recurringQuestions: [] }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://127.0.0.1:5180') return route.abort()
    const path = url.pathname
    if (!path.startsWith('/twitch/') && !path.startsWith('/community-pulse')) return route.continue()
    const method = route.request().method()
    const body = route.request().postDataJSON()
    if (method !== 'GET') state.mutations.push({ path, method, body })
    let result: unknown = null
    let status = 200
    if (path === '/twitch/status') result = { state: state.reconnecting ? 'connecting' : state.connected ? 'connected' : 'disconnected', subscription: state.reconnecting ? 'pending' : state.connected ? 'enabled' : 'none', authorization: { state: state.connected ? 'signed_in' : 'signed_out' }, chatWriteEnabled: state.connected, sessionPersistence: { state: state.persistenceFailed ? 'degraded' : 'healthy', historyMayBeIncomplete: state.persistenceFailed } }
    else if (path === '/twitch/logout') { state.connected = false; result = { signedOut: true, twitchAuthorizationRevoked: false } }
    else if (path === '/twitch/messages') result = { messages: state.connected ? messages : [] }
    else if (path.endsWith('/questions/status')) { state.statuses[body.questionId] = body.status === 'open' ? 'unanswered' : body.status; result = { saved: true } }
    else if (path.endsWith('/questions/priority')) { state.priorities[body.questionId] = body.priority; result = { saved: true } }
    else if (path === '/twitch/sessions') {
      const questions = groupQuestions(messages, state.statuses, 'live', { broadcasterId: 'fixture-channel', sessionId: 'fixture-session' }, state.priorities)
      result = { sessions: state.connected ? [{ id: 'fixture-session', streamId: 'fixture-stream', broadcasterId: 'fixture-channel', status: state.completed ? 'completed' : 'active', startedAt: '2026-10-31T10:00:00Z', endedAt: state.completed ? '2026-10-31T10:30:00Z' : null, captureComplete: !state.persistenceFailed, totalMessages: messages.length, uniqueViewerCount: 4, questionStatuses: state.statuses, questionPriorities: state.priorities, analysis: null, communityPulse: null, metrics: { totalMessages: messages.length, uniqueViewers: 4, totalQuestions: questions.length, answeredQuestions: questions.filter(q => q.status === 'answered').length, unansweredQuestions: questions.filter(q => q.status === 'unanswered').length, repeatedQuestions: 1, pollCount: state.poll?.startedAt ? 1 : 0, totalVotes: state.poll?.totalVotes ?? 0, questions: questions.map(q => ({ ...q, count: q.messageIds.length, priority: q.manualPriority })), polls: state.poll ? [state.poll] : [] } }] : [] }
    } else if (path.endsWith('/analyze')) result = { analysis: { insufficientData: false, summary: 'The recorded discussion focused on next-stream choices.', topics: [], recurringQuestions: [], audienceRequests: [], nextStreamTopics: [{ text: 'Discuss next-stream game choices.', messageIds: ['fixture-1', 'fixture-2'] }], contentIdeas: [], provider: 'fixture', analyzedAt: '2026-10-31T10:31:00Z' } }
    else if (path === '/community-pulse') { result = state.aiFailed ? { error: 'Analysis provider is temporarily unavailable.' } : { provider: 'fixture', pulse }; status = state.aiFailed ? 503 : 200 }
    else if (path === '/community-pulse/poll') result = { provider: 'fixture', suggestion: { question: 'Which game format should we try next?', options: ['Co-op adventure', 'Solo challenge'], explanation: 'Chat asked about the next game.', messageIds: ['fixture-1', 'fixture-2'] } }
    else if (path === '/twitch/polls/current' || path === '/twitch/polls/results') result = state.poll
    else if (path === '/twitch/polls/status') result = { status: state.poll?.status ?? 'none', totalVotes: state.poll?.totalVotes ?? 0, voteFeedback: null, chatAnnouncement: null }
    else if (path === '/twitch/polls' && method === 'POST') {
      if (state.saveFailed) { status = 503; result = { error: 'Draft could not be written.' } }
      else { state.poll = { ...makePoll('draft'), question: body.question, options: body.options.map((text: string, i: number) => ({ id: String(i + 1), text, votes: 0 })) }; result = state.poll }
    } else if (path.endsWith('/activate') && state.poll) { state.poll.status = 'active'; state.poll.startedAt = '2026-10-31T10:05:00Z'; result = state.poll }
    else if (path.endsWith('/close') && state.poll) { state.poll.status = 'closed'; state.poll.endedAt = '2026-10-31T10:10:00Z'; result = state.poll }
    else if (method === 'PATCH' && state.poll) { state.poll.question = body.question; state.poll.options = body.options.map((text: string, i: number) => ({ id: String(i + 1), text, votes: 0 })); result = state.poll }
    else if (path.endsWith('/announce')) result = state.poll
    else { status = 404; result = { error: 'Unknown fixture API route' } }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.addInitScript(() => window.localStorage.setItem('chatbeacon-theme', 'dark'))
  return state
}
