import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const dom = new JSDOM('<!doctype html><html><body><div id="test-root"></div></body></html>', {
  url: 'http://localhost:5173/',
})
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})

const { cleanup, render, screen, within } = await import('@testing-library/react')
const userEventModule = await import('@testing-library/user-event')
const userEvent = userEventModule.default as unknown as {
  setup(options: { document: Document }): {
    click(target: Element): Promise<void>
    clear(target: Element): Promise<void>
    type(target: Element, text: string): Promise<void>
  }
}
const { default: App } = await import('../src/App.tsx')

type MockResponse = { status?: number; body: unknown }
type FetchHandler = (path: string, init?: RequestInit) => MockResponse | Promise<MockResponse>

const liveMessages = [
  { messageId: 'chat-1', timestamp: '2026-10-31T10:00:00.000Z', chatterName: 'MiraByte', text: 'What should we play this weekend?' },
  { messageId: 'chat-2', timestamp: '2026-10-31T10:01:00.000Z', chatterName: 'PixelPanda', text: 'WHAT should we play this weekend?!' },
  { messageId: 'chat-3', timestamp: '2026-10-31T10:02:00.000Z', chatterName: 'LimeByte', text: 'Will you stream tomorrow?' },
]

function session(captureComplete = true) {
  return {
    id: 'session-1', streamId: 'stream-1', broadcasterId: 'broadcaster-1',
    startedAt: '2026-10-31T09:00:00.000Z', endedAt: null, status: 'active', captureComplete,
    totalMessages: 3, uniqueViewerCount: 3, questionStatuses: {} as Record<string, string>, questionPriorities: {} as Record<string, 0 | 1 | 2>,
    analysis: null, communityPulse: null,
    metrics: {
      totalMessages: 3, uniqueViewers: 3, totalQuestions: 0, answeredQuestions: 0,
      unansweredQuestions: 0, repeatedQuestions: 0, pollCount: 0, totalVotes: 0,
      questions: [], polls: [],
    },
  }
}

function poll(status: 'draft' | 'active' | 'closed' = 'draft', question = 'What should we play next?', options = ['Story mode', 'Arena mode']) {
  return {
    id: 'poll-1', question,
    options: options.map((text, index) => ({ id: `option-${index + 1}`, text, votes: 0 })),
    status, createdAt: '2026-10-31T10:00:00.000Z',
    startedAt: status === 'draft' ? null : '2026-10-31T10:01:00.000Z',
    endedAt: status === 'closed' ? '2026-10-31T10:05:00.000Z' : null,
    totalVotes: 0,
  }
}

const voteStatus = { status: 'none', totalVotes: 0, voteFeedback: null, chatAnnouncement: null }

let handler: FetchHandler
let requestLog: Array<{ path: string; method: string; body: unknown }> = []
let timerCallbacks = new Map<number, () => void>()
let nextTimerId = 1
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function baseFetch(overrides: Partial<{
  connected: boolean
  persistence: 'healthy' | 'degraded'
  sessions: unknown[]
  currentPoll: unknown
  status: unknown
  messages: unknown[]
}> = {}): FetchHandler {
  const connected = overrides.connected ?? true
  const streamSession = session(overrides.persistence !== 'degraded')
  return (path, init) => {
    const method = init?.method ?? 'GET'
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    const statusMatch = path.match(/^\/twitch\/sessions\/([^/]+)\/questions\/status$/u)
    if (statusMatch && method === 'POST' && body && typeof body === 'object') {
      const update = body as { questionId?: string; status?: string }
      if (update.questionId && update.status) streamSession.questionStatuses[update.questionId] = update.status as never
      return { body: { ok: true } }
    }
    const priorityMatch = path.match(/^\/twitch\/sessions\/([^/]+)\/questions\/priority$/u)
    if (priorityMatch && method === 'POST' && body && typeof body === 'object') {
      const update = body as { questionId?: string; priority?: 0 | 1 | 2 }
      if (update.questionId && update.priority !== undefined) streamSession.questionPriorities[update.questionId] = update.priority
      return { body: { ok: true } }
    }
    if (path === '/twitch/status') return { body: overrides.status ?? {
      state: connected ? 'connected' : 'disconnected',
      subscription: connected ? 'enabled' : 'none',
      chatWriteEnabled: true,
      sessionPersistence: { state: overrides.persistence ?? 'healthy', historyMayBeIncomplete: overrides.persistence === 'degraded' },
    } }
    if (path === '/twitch/messages') return { body: { messages: overrides.messages ?? (connected ? liveMessages : []) } }
    if (path === '/twitch/sessions') return { body: { sessions: overrides.sessions ?? (connected ? [streamSession] : []) } }
    if (path === '/twitch/polls/current') return { body: overrides.currentPoll ?? null }
    if (path === '/twitch/polls/results') return { body: overrides.currentPoll ?? null }
    if (path === '/twitch/polls/status') return { body: voteStatus }
    if (path === '/community-pulse') return { body: { provider: 'groq', pulse: {
      insufficientData: false,
      overallSummary: 'Viewers are choosing the next game.',
      topics: [{ title: 'Choosing a game', explanation: 'Several viewers asked what comes next.', messageIds: ['chat-1', 'chat-2'], representativeMessages: liveMessages.slice(0, 2) }],
      recurringQuestions: [],
    } } }
    if (path === '/community-pulse/poll') return { body: { provider: 'groq', suggestion: {
      question: 'What should we play next?', options: ['Story mode', 'Arena mode'],
      explanation: 'Chat has asked about the next game.', messageIds: ['chat-1', 'chat-2'],
    } } }
    return { body: { ok: true } }
  }
}

function installFetch(next: FetchHandler) {
  handler = next
  requestLog = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(rawUrl, window.location.origin).pathname
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    requestLog.push({ path, method: init?.method ?? 'GET', body })
    const result = await handler(path, init)
    return json(result.body, result.status ?? 200)
  }) as typeof fetch
}

function mount() {
  return render(<App />)
}

function pulseSection() {
  return document.querySelector('#community-pulse') as HTMLElement
}

function questionsPanel() {
  return document.querySelector('.questions-panel') as HTMLElement
}

function beaconSection() {
  return document.querySelector('#beacon-pulse') as HTMLElement
}

beforeEach(() => {
  window.localStorage.clear()
  timerCallbacks = new Map()
  nextTimerId = 1
  globalThis.setInterval = ((callback: TimerHandler) => {
    const id = nextTimerId++
    if (typeof callback === 'function') timerCallbacks.set(id, callback as () => void)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id: number | undefined) => { if (id !== undefined) timerCallbacks.delete(id) }) as typeof clearInterval
  installFetch(baseFetch())
})

afterEach(() => {
  cleanup()
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})

test('renders a question queue and supports follow-up, answered, reopen, priority, and filtering', async () => {
  const user = userEvent.setup({ document })
  mount()
  await screen.findByText('Live', { exact: true })
  await screen.findByText('A stream session is in progress')
  const questionCard = within(questionsPanel()).getByText('What should we play this weekend?').closest('article') as HTMLElement
  assert.ok(questionCard)
  assert.match(questionCard.textContent ?? '', /Asked 2 times · 2 chatters/u)

  await user.click(within(questionCard).getByRole('button', { name: 'Mark question for follow-up' }))
  const statusFeedback = await screen.findByText(/^Question marked for follow-up/u)
  assert.equal(statusFeedback.textContent, 'Question marked for follow-up and saved.')
  assert.equal(requestLog.some((entry) => entry.path === '/twitch/sessions/session-1/questions/status' && (entry.body as { status?: string }).status === 'follow_up'), true, JSON.stringify(requestLog))

  await user.click(screen.getByRole('button', { name: /^Follow up/u }))
  assert.ok(within(questionsPanel()).getByText('What should we play this weekend?'))
  const followUpCard = within(questionsPanel()).getByText('What should we play this weekend?').closest('article') as HTMLElement
  await user.click(within(followUpCard).getByRole('button', { name: 'Mark follow-up question answered' }))
  await screen.findByText('Question marked answered and saved.')
  await user.click(screen.getByRole('button', { name: /^Answered/u }))
  const answeredCard = within(questionsPanel()).getByText('What should we play this weekend?').closest('article') as HTMLElement
  await user.click(within(answeredCard).getByRole('button', { name: 'Reopen question' }))
  await screen.findByText('Question reopened and saved.')

  await user.click(screen.getByRole('button', { name: /^All/u }))
  const reopenedCard = within(questionsPanel()).getByText('What should we play this weekend?').closest('article') as HTMLElement
  await user.click(within(reopenedCard).getByRole('button', { name: /Set priority:/u }))
  await screen.findByRole('button', { name: /current priority 2 of 3/u })
  assert.equal(requestLog.some((entry) => entry.path.endsWith('/questions/priority') && (entry.body as { priority?: number }).priority === 1), true)
})

test('reports a failed question save and rolls the optimistic status back', async () => {
  const user = userEvent.setup({ document })
  installFetch((path, init) => {
    if (path.endsWith('/questions/status') && init?.method === 'POST') return { status: 503, body: { error: 'storage unavailable' } }
    return baseFetch()(path, init)
  })
  mount()
  await screen.findByText('A stream session is in progress')
  const card = (await within(questionsPanel()).findByText('What should we play this weekend?')).closest('article') as HTMLElement
  await user.click(within(card).getByRole('button', { name: 'Mark question answered' }))
  await screen.findByText('The question status could not be saved. Please try again.')
  assert.ok(within(card).getByRole('button', { name: 'Mark question answered' }))
})

test('reviews and saves a valid AI suggestion without edits, then activates it explicitly', async () => {
  const user = userEvent.setup({ document })
  let currentPoll: ReturnType<typeof poll> | null = null
  installFetch((path, init) => {
    if (path === '/twitch/polls/current' || path === '/twitch/polls/results') return { body: currentPoll }
    if (path === '/twitch/polls/status') return { body: { ...voteStatus, status: currentPoll?.status ?? 'none' } }
    if (path === '/twitch/polls' && init?.method === 'POST') {
      currentPoll = poll('draft', (JSON.parse(String(init.body)) as { question: string }).question)
      return { body: currentPoll }
    }
    if (path === '/twitch/polls/poll-1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { question: string; options: string[] }
      currentPoll = poll('draft', body.question, body.options)
      return { body: currentPoll }
    }
    if (path === '/twitch/polls/poll-1/activate' && init?.method === 'POST') {
      currentPoll = poll('active', currentPoll?.question, currentPoll?.options.map((option) => option.text))
      return { body: currentPoll }
    }
    return baseFetch()(path, init)
  })
  mount()
  await screen.findByText('Live', { exact: true })
  await user.click(screen.getByRole('button', { name: 'Analyze chat' }))
  await within(pulseSection()).findByRole('button', { name: 'Suggest a poll' })
  await user.click(within(pulseSection()).getByRole('button', { name: 'Suggest a poll' }))
  await screen.findByRole('button', { name: 'Save as poll draft' })
  await user.click(screen.getByRole('button', { name: 'Save as poll draft' }))
  await within(pulseSection()).findByText('Saved as a draft. It has not been published; activate it in Beacon Pulse when ready.')
  assert.equal(requestLog.some((entry) => entry.path === '/twitch/polls' && entry.method === 'POST'), true)

  await user.click(within(beaconSection()).getByRole('button', { name: 'Approve and activate' }))
  await screen.findByText(/Poll is active\. Viewers can vote in chat/u)
  assert.equal(requestLog.some((entry) => entry.path === '/twitch/polls/poll-1/activate' && entry.method === 'POST'), true)
})

test('saved draft edits stay visible after a failed save', async () => {
  const user = userEvent.setup({ document })
  let currentPoll: ReturnType<typeof poll> | null = poll('draft', 'What should we play next?')
  installFetch((path, init) => {
    if (path === '/twitch/polls/current' || path === '/twitch/polls/results') return { body: currentPoll }
    if (path === '/twitch/polls/status') return { body: { ...voteStatus, status: 'draft' } }
    if (path === '/twitch/polls/poll-1' && init?.method === 'PATCH') return { status: 503, body: { error: 'Draft could not be written.' } }
    return baseFetch()(path, init)
  })
  mount()
  const question = await within(beaconSection()).findByLabelText('Poll question')
  await user.type(question, ' Which mode should we try tonight?')
  await user.click(within(beaconSection()).getByRole('button', { name: 'Save edits' }))
  await within(beaconSection()).findByText('Draft could not be written.')
  assert.equal((within(beaconSection()).getByLabelText('Poll question') as HTMLInputElement).value, 'What should we play next? Which mode should we try tonight?')
})

test('does not enable saving or activating an invalid saved draft', async () => {
  installFetch(baseFetch({ currentPoll: poll('draft', 'No', ['same', 'same']) }))
  mount()
  await within(beaconSection()).findByText(/5–140 character question/u)
  assert.equal(within(beaconSection()).getByRole('button', { name: 'Approve and activate' }).hasAttribute('disabled'), true)
  assert.equal(within(beaconSection()).getByRole('button', { name: 'Save edits' }).hasAttribute('disabled'), true)
})

test('keeps an edited topic suggestion while refreshing Community Pulse', async () => {
  const user = userEvent.setup({ document })
  let analysisCalls = 0
  const base = baseFetch()
  installFetch((path, init) => {
    if (path === '/community-pulse') {
      analysisCalls += 1
      return base(path, init)
    }
    if (path === '/community-pulse/poll') return base(path, init)
    return base(path, init)
  })
  mount()
  await screen.findByText('Live', { exact: true })
  await screen.findByText('A stream session is in progress')
  await user.click(screen.getByRole('button', { name: 'Analyze chat' }))
  await screen.findByRole('button', { name: 'Suggest a poll' })
  await user.click(within(pulseSection()).getByRole('button', { name: 'Suggest a poll' }))
  const question = await within(pulseSection()).findByLabelText('Poll question')
  await user.clear(question)
  await user.type(question, 'What game should we play next?')
  await user.click(screen.getByRole('button', { name: 'Refresh analysis' }))
  await screen.findByText('Viewers are choosing the next game.')
  assert.equal((within(pulseSection()).getByLabelText('Poll question') as HTMLInputElement).value, 'What game should we play next?')
  assert.equal(analysisCalls, 2)
})

test('shows connection, persistence, and incomplete recap states without claiming full capture', async () => {
  installFetch(baseFetch({ persistence: 'degraded', sessions: [session(false)] }))
  mount()
  await screen.findByText('Live', { exact: true })
  await screen.findByText('A stream session is in progress')
  assert.match(within(document.querySelector('#stream-recap') as HTMLElement).getByText(/Session storage is having trouble/u).textContent ?? '', /incomplete/u)
  assert.match(within(document.querySelector('#stream-recap') as HTMLElement).getByText(/This session missed one or more persistence writes/u).textContent ?? '', /incomplete/u)

  cleanup()
  installFetch(baseFetch({ connected: false }))
  mount()
  await screen.findByText('Connection issue', { exact: true })
  assert.match(document.querySelector('.demo-badge')?.textContent ?? '', /Demo mode.*sample data/u)

  cleanup()
  installFetch(baseFetch({ connected: false, status: {
    state: 'connecting', subscription: 'pending', chatWriteEnabled: false,
    sessionPersistence: { state: 'unknown', historyMayBeIncomplete: false },
  } }))
  mount()
  await screen.findByText('Connecting', { exact: true })
})

test('shows Reconnecting after a previously confirmed live connection drops', async () => {
  const status = {
    state: 'connected', subscription: 'enabled', chatWriteEnabled: true,
    sessionPersistence: { state: 'healthy', historyMayBeIncomplete: false },
  }
  installFetch(baseFetch({ status }))
  mount()
  await screen.findByText('Live', { exact: true })
  status.state = 'connecting'
  status.subscription = 'pending'
  await act(async () => {
    for (const callback of timerCallbacks.values()) callback()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await screen.findByText('Reconnecting', { exact: true })
  assert.match(document.querySelector('.demo-badge')?.textContent ?? '', /Live mode.*Twitch messages/u)
})

test('shows Community Pulse loading and provider failure feedback', async () => {
  const user = userEvent.setup({ document })
  let release!: (response: MockResponse) => void
  installFetch((path, init) => path === '/community-pulse'
    ? new Promise<MockResponse>((resolve) => { release = resolve })
    : baseFetch()(path, init))
  mount()
  await screen.findByText('Live', { exact: true })
  await user.click(screen.getByRole('button', { name: 'Analyze chat' }))
  await screen.findByText('Reviewing up to 50 recent messages…')
  await act(async () => { release({ status: 503, body: { error: 'Analysis provider is temporarily unavailable.' } }) })
  await screen.findByText('Analysis provider is temporarily unavailable.')
})

test('Create another poll keeps a custom editor through polling and starts without a separate draft approval', async () => {
  const user = userEvent.setup({ document })
  let stored = poll('closed')
  const base = baseFetch()
  installFetch((path, init) => {
    if (path === '/twitch/polls/current' || path === '/twitch/polls/results') return { body: stored }
    if (path === '/twitch/polls/status') return { body: { ...voteStatus, status: stored.status } }
    if (path === '/twitch/polls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { question: string; options: string[] }
      stored = poll('draft', body.question, body.options)
      return { body: stored }
    }
    if (path.endsWith('/activate')) { stored = { ...stored, status: 'active' }; return { body: stored } }
    return base(path, init)
  })
  mount()
  await user.click(await within(beaconSection()).findByRole('button', { name: 'Create another poll' }))
  await user.type(within(beaconSection()).getByLabelText('Poll question'), 'Which challenge should we try?')
  await user.type(within(beaconSection()).getByLabelText('Poll answer option 1'), 'Speed run')
  await user.type(within(beaconSection()).getByLabelText('Poll answer option 2'), 'No damage')
  await act(async () => { for (const callback of timerCallbacks.values()) callback(); await new Promise((resolve) => setTimeout(resolve, 20)) })
  assert.equal((within(beaconSection()).getByLabelText('Poll question') as HTMLInputElement).value, 'Which challenge should we try?')
  await user.click(within(beaconSection()).getByRole('button', { name: 'Start poll' }))
  await within(beaconSection()).findByRole('button', { name: 'Close poll' })
  assert.equal(stored.question, 'Which challenge should we try?')
  assert.deepEqual(stored.options.map((option) => option.text), ['Speed run', 'No damage'])
  assert.equal(requestLog.filter((request) => request.path.endsWith('/activate')).length, 1)
})

test('failed direct activation retains the saved draft and edited values for retry', async () => {
  const user = userEvent.setup({ document })
  installFetch((path, init) => {
    if (path === '/twitch/polls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { question: string; options: string[] }
      return { body: poll('draft', body.question, body.options) }
    }
    if (path.endsWith('/activate')) return { status: 503, body: { error: 'Activation is temporarily unavailable.' } }
    return baseFetch()(path, init)
  })
  mount()
  const input = await within(beaconSection()).findByLabelText('Poll question')
  await user.type(input, 'What should we build next?')
  await user.type(within(beaconSection()).getByLabelText('Poll answer option 1'), 'A village')
  await user.type(within(beaconSection()).getByLabelText('Poll answer option 2'), 'A castle')
  await user.click(within(beaconSection()).getByRole('button', { name: 'Start poll' }))
  await screen.findByText('Activation is temporarily unavailable.')
  assert.equal((within(beaconSection()).getByLabelText('Poll question') as HTMLInputElement).value, 'What should we build next?')
  assert.ok(within(beaconSection()).getByRole('button', { name: 'Approve and activate' }))
})

test('theme toggle is keyboard-accessible and persists across remounts', async () => {
  const user = userEvent.setup({ document })
  mount()
  const toggle = screen.getByRole('button', { name: 'Dark theme' })
  await user.click(toggle)
  assert.equal(document.documentElement.dataset.theme, 'light')
  assert.equal(window.localStorage.getItem('chatbeacon-theme'), 'light')
  cleanup()
  mount()
  assert.equal(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed'), 'false')
})

test('sign out is confirmed by the backend and returns to clearly labelled demo mode', async () => {
  const user = userEvent.setup({ document })
  let signedOut = false
  installFetch((path, init) => {
    if (path === '/twitch/logout') { signedOut = true; return { body: { signedOut: true, twitchAuthorizationRevoked: false } } }
    return baseFetch({ connected: !signedOut, status: { state: signedOut ? 'disconnected' : 'connected', subscription: signedOut ? 'none' : 'enabled', authorization: { state: signedOut ? 'signed_out' : 'signed_in' } } })(path, init)
  })
  mount()
  await user.click(await screen.findByRole('button', { name: 'Sign out' }))
  await screen.findByText(/Signed out of ChatBeacon/u)
  assert.ok(screen.getByRole('link', { name: 'Sign in with Twitch' }))
  assert.match(document.querySelector('.demo-badge')?.textContent ?? '', /Demo mode/u)
  assert.equal(requestLog.find((entry) => entry.path === '/twitch/logout')?.method, 'POST')
})

test('a failed history refresh does not undo an accepted question status change', async () => {
  const user = userEvent.setup({ document })
  let failHistory = false
  const base = baseFetch()
  installFetch((path, init) => {
    if (path.endsWith('/questions/status')) failHistory = true
    if (path === '/twitch/sessions' && failHistory) return { status: 503, body: {} }
    return base(path, init)
  })
  mount()
  await screen.findByText('A stream session is in progress')
  const card = within(questionsPanel()).getByText('What should we play this weekend?').closest('article') as HTMLElement
  await user.click(within(card).getByRole('button', { name: 'Mark question answered' }))
  await screen.findByText('Question marked answered and saved.')
  await screen.findByText('Your change was saved, but session history could not be refreshed.')
  assert.ok(within(card).getByRole('button', { name: 'Reopen question' }))
})
