import { useEffect, useMemo, useRef, useState } from 'react'
import { findRelatedQuestionSuggestions, groupQuestions, mergeChatHistory, normalizeQuestionText, questionIdFor, sortQuestionsByPriority, type QuestionMessage, type QuestionStatus, type QuestionStatusMap, type QuestionPriorityMap } from './questionTracking.js'
import { isValidPollInput, parseSavedPoll, parseVoteStatus, updateDraftPollQuestion, type SavedPoll, type VoteStatus } from './polling.js'
import { buildOverviewTiles, dashboardNavigation, getPollOverlayUrl } from './dashboardModel.js'
import ThemeToggle from './ThemeToggle.js'

type QuestionFilter = 'all' | QuestionStatus

type ChatMessage = QuestionMessage

type FeedState = 'connecting' | 'live' | 'issue'

type TwitchStatus = {
  state: string
  subscription: string
  chatWriteEnabled?: boolean
  authorization?: { state: 'signed_in' | 'signed_out' | 'restoring' | 'error'; message?: string }
  sessionPersistence?: { state: 'unknown' | 'healthy' | 'degraded'; historyMayBeIncomplete: boolean }
}

type ConnectionReadiness = 'unknown' | 'connecting' | 'connected' | 'disconnected'
type PulseEvidenceMessage = Pick<ChatMessage, 'messageId' | 'timestamp' | 'chatterName' | 'text'>
type CommunityPulseTopic = {
  title: string
  explanation: string
  messageIds: string[]
  representativeMessages: PulseEvidenceMessage[]
}
type CommunityPulseQuestion = {
  text: string
  messageIds: string[]
  representativeMessages: PulseEvidenceMessage[]
}
type CommunityPulseResult = {
  provider: string
  pulse: {
    insufficientData: boolean
    insufficientReason?: string
    topics: CommunityPulseTopic[]
    recurringQuestions: CommunityPulseQuestion[]
    overallSummary: string
  }
}
type PollDraft = {
  question: string
  options: string[]
  explanation: string
  messageIds: string[]
  provider: string
  edited: boolean
  approved: boolean
  activated?: boolean
}

type RecapMetrics = {
  totalMessages: number; uniqueViewers: number; totalQuestions: number; answeredQuestions: number; unansweredQuestions: number;
  repeatedQuestions: number; pollCount: number; totalVotes: number;
  questions: Array<{ id: string; text: string; count: number; status: QuestionStatus; priority: 0 | 1 | 2 }>
  polls: Array<{ status: string; totalVotes: number; options: Array<{ id: string; text: string; votes: number }> }>
}
type RecapAnalysis = {
  insufficientData: boolean; insufficientReason?: string; summary: string;
  topics: Array<{ title: string; explanation: string; messageIds: string[] }>;
  recurringQuestions: Array<{ text: string; messageIds: string[] }>;
  audienceRequests: Array<{ text: string; messageIds: string[] }>;
  nextStreamTopics: Array<{ text: string; messageIds: string[] }>;
  contentIdeas: Array<{ text: string; messageIds: string[] }>;
  provider: string; analyzedAt: string
}
type RecapSession = {
  id: string; streamId: string; broadcasterId: string; startedAt: string; endedAt: string | null; status: 'active' | 'completed' | 'interrupted';
  captureComplete?: boolean;
  totalMessages: number; uniqueViewerCount: number; questionStatuses: QuestionStatusMap; analysis: RecapAnalysis | null; metrics: RecapMetrics;
  questionPriorities?: QuestionPriorityMap;
  communityPulse: { pulse: { overallSummary: string; topics: Array<{ title: string; explanation: string }>; recurringQuestions: Array<{ text: string }> }; provider: string; analyzedAt: string } | null
}

const sampleNow = Date.now()
const sampleChatMessages = [
  { messageId: 'demo-1', timestamp: new Date(sampleNow - 6 * 60_000).toISOString(), name: 'MiraByte', time: 'just now', text: 'What time do you usually stream on weekends?', tone: 'violet' },
  { messageId: 'demo-2', timestamp: new Date(sampleNow - 5 * 60_000).toISOString(), name: 'PixelPanda', time: '1m ago', text: 'That last run was so close 😅', tone: 'blue' },
  { messageId: 'demo-3', timestamp: new Date(sampleNow - 4 * 60_000).toISOString(), name: 'AlexArcade', time: '2m ago', text: 'Can you share the name of that keyboard?', tone: 'orange' },
  { messageId: 'demo-4', timestamp: new Date(sampleNow - 3 * 60_000).toISOString(), name: 'LunaticLime', time: '2m ago', text: 'The new overlay looks great!', tone: 'green' },
  { messageId: 'demo-5', timestamp: new Date(sampleNow - 2 * 60_000).toISOString(), name: 'MintCondition', time: '3m ago', text: 'Will the VOD be uploaded after stream?', tone: 'pink' },
  { messageId: 'demo-6', timestamp: new Date(sampleNow - 60_000).toISOString(), name: 'cozy_cactus', time: '4m ago', text: 'Do you have any tips for a first playthrough?', tone: 'gold' },
  { messageId: 'demo-7', timestamp: new Date(sampleNow).toISOString(), name: 'WeekendViewer', time: 'just now', text: 'WHAT TIME do you usually stream on weekends?!', tone: 'blue' },
]

const demoQuestionMessages: QuestionMessage[] = sampleChatMessages.map((message) => ({
  messageId: message.messageId,
  timestamp: message.timestamp,
  chatterName: message.name,
  text: message.text,
}))

const questionStatusStorageKey = 'chatbeacon.question-statuses.v1'
const defaultQuestionStatuses: QuestionStatusMap = {
  [questionIdFor('demo', normalizeQuestionText('Will the VOD be uploaded after stream?'))]: 'answered',
  [questionIdFor('demo', normalizeQuestionText('Do you have any tips for a first playthrough?'))]: 'answered',
}

function readQuestionStatuses(): QuestionStatusMap {
  try {
    const saved = window.localStorage.getItem(questionStatusStorageKey)
    if (!saved) return defaultQuestionStatuses
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultQuestionStatuses
    const validEntries = Object.entries(parsed).filter((entry): entry is [string, QuestionStatus] =>
      entry[1] === 'answered' || entry[1] === 'unanswered' || entry[1] === 'follow_up',
    )
    return { ...defaultQuestionStatuses, ...Object.fromEntries(validEntries) }
  } catch {
    return defaultQuestionStatuses
  }
}

const filters: { id: QuestionFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unanswered', label: 'Unanswered' },
  { id: 'answered', label: 'Answered' },
  { id: 'follow_up', label: 'Follow up' },
]

function parseMessagesResponse(value: unknown): ChatMessage[] | null {
  if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages)) return null

  const parsed: ChatMessage[] = []
  for (const item of value.messages) {
    if (!item || typeof item !== 'object') return null
    const message = item as Record<string, unknown>
    if (
      typeof message.messageId !== 'string' ||
      typeof message.timestamp !== 'string' ||
      typeof message.chatterName !== 'string' ||
      typeof message.text !== 'string' ||
      !message.messageId ||
      !Number.isFinite(Date.parse(message.timestamp))
    ) return null
    parsed.push({
      messageId: message.messageId,
      timestamp: message.timestamp,
      chatterName: message.chatterName,
      text: message.text,
    })
  }

  const unique = new Map<string, ChatMessage>()
  for (const message of parsed) unique.set(message.messageId, message)
  return [...unique.values()]
    .sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))
    .slice(0, 100)
}

function isTwitchStatus(value: unknown): value is TwitchStatus {
  return Boolean(
    value && typeof value === 'object' &&
    'state' in value && typeof value.state === 'string' &&
    'subscription' in value && typeof value.subscription === 'string',
  )
}

function messageTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function questionSeenTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function getOAuthFeedback(): { tone: 'success' | 'info' | 'issue'; text: string } | null {
  const result = new URLSearchParams(window.location.search).get('twitch')
  if (result === 'connected') return { tone: 'success', text: 'Twitch chat connected successfully.' }
  if (result === 'cancelled') return { tone: 'info', text: 'Twitch authorization was cancelled. You can connect again when ready.' }
  if (result === 'permission') return { tone: 'issue', text: 'Twitch chat permission is needed. Connect again and approve the requested access.' }
  if (result === 'error') return { tone: 'issue', text: 'Twitch could not connect. Check the backend status and try again.' }
  return null
}

function BeaconMark() {
  return (
    <svg className="beacon-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="13" fill="currentColor" />
      <path d="M15 26.5h10M16 22h8l-1.2-8h-5.6L16 22Zm4-12v3m-8 4 4 2m12-2-4 2M13 29.5h14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function App() {
  const [filter, setFilter] = useState<QuestionFilter>('all')
  const [questionStatuses, setQuestionStatuses] = useState<QuestionStatusMap>(readQuestionStatuses)
  const [questionPriorities, setQuestionPriorities] = useState<QuestionPriorityMap>({})
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [usingRealMessages, setUsingRealMessages] = useState(false)
  const realMessageMode = useRef(false)
  const [feedState, setFeedState] = useState<FeedState>('connecting')
  const [connectionReadiness, setConnectionReadiness] = useState<ConnectionReadiness>('unknown')
  const [authorizationState, setAuthorizationState] = useState('unknown')
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [authNotice, setAuthNotice] = useState('')
  const [authError, setAuthError] = useState('')
  const accountGeneration = useRef(0)
  const [sessionPersistenceIssue, setSessionPersistenceIssue] = useState(false)
  const [feedDetail, setFeedDetail] = useState('Checking the backend and Twitch subscription…')
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [messagesStale, setMessagesStale] = useState(false)
  const [oauthFeedback] = useState(getOAuthFeedback)
  const [questionActionMessage, setQuestionActionMessage] = useState('')
  const [pulseResult, setPulseResult] = useState<CommunityPulseResult | null>(null)
  const [pulseLoading, setPulseLoading] = useState(false)
  const [pulseError, setPulseError] = useState('')
  const pulseRequest = useRef<AbortController | null>(null)
  const pulseRequestLocked = useRef(false)
  const [pollDrafts, setPollDrafts] = useState<Record<string, PollDraft>>({})
  const [pollLoading, setPollLoading] = useState<Record<string, boolean>>({})
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({})
  const pollRequests = useRef(new Map<string, AbortController>())
  const [savedPoll, setSavedPoll] = useState<SavedPoll | null>(null)
  const [pollQuestion, setPollQuestion] = useState('')
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [pollBusy, setPollBusy] = useState(false)
  const pollMutationLocked = useRef(false)
  const pollEditorDirty = useRef(false)
  const [pollLoaded, setPollLoaded] = useState(false)
  const [savedPollError, setSavedPollError] = useState('')
  const [pollResultsError, setPollResultsError] = useState('')
  const [voteStatus, setVoteStatus] = useState<VoteStatus | null>(null)
  const [chatWriteEnabled, setChatWriteEnabled] = useState(false)
  const [overlayFeedback, setOverlayFeedback] = useState('')
  const [recapSessions, setRecapSessions] = useState<RecapSession[]>([])
  const [selectedRecapId, setSelectedRecapId] = useState('')
  const [recapLoading, setRecapLoading] = useState(false)
  const [recapBusy, setRecapBusy] = useState(false)
  const [recapError, setRecapError] = useState('')
  const [recapNotice, setRecapNotice] = useState('')

  async function refreshRecapSessions(signal?: AbortSignal) {
    setRecapLoading(true)
    try {
      const response = await fetch('/twitch/sessions', { cache: 'no-store', signal })
      const result: unknown = await response.json()
      if (!response.ok || !result || typeof result !== 'object' || !('sessions' in result) || !Array.isArray(result.sessions)) throw new Error('Session history could not be loaded.')
      const sessions = result.sessions as RecapSession[]
      setRecapSessions(sessions)
      setSelectedRecapId((current) => sessions.some((session) => session.id === current) ? current : sessions.find((session) => session.status === 'active')?.id ?? sessions[0]?.id ?? '')
      const activeSession = sessions.find((session) => session.status === 'active')
      if (activeSession) {
        setQuestionStatuses((current) => ({ ...current, ...activeSession.questionStatuses }))
        setQuestionPriorities(activeSession.questionPriorities ?? {})
      }
      setRecapError('')
    } finally { setRecapLoading(false) }
  }

  useEffect(() => {
    if (connectionReadiness !== 'connected') return
    let mounted = true
    let busy = false
    let timer: ReturnType<typeof setInterval> | undefined
    let controller: AbortController | null = null
    const refresh = async () => {
      if (!mounted || busy) return
      busy = true
      controller = new AbortController()
      try { await refreshRecapSessions(controller.signal) } catch (error) {
        if (mounted && !controller.signal.aborted) setRecapError(error instanceof Error ? error.message : 'Session history is temporarily unavailable.')
      } finally { busy = false }
    }
    void refresh()
    timer = setInterval(() => { void refresh() }, 15_000)
    return () => { mounted = false; if (timer) clearInterval(timer); controller?.abort() }
  }, [connectionReadiness])

  async function analyzeSelectedSession() {
    if (!selectedRecapId || recapBusy) return
    setRecapBusy(true); setRecapError(''); setRecapNotice('')
    try {
      const response = await fetch(`/twitch/sessions/${encodeURIComponent(selectedRecapId)}/analyze`, { method: 'POST', cache: 'no-store' })
      const result: unknown = await response.json()
      if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Session analysis could not be completed.')
      const analysis = (result as { analysis?: RecapAnalysis }).analysis
      if (!analysis) throw new Error('The session analysis response was incomplete.')
      setRecapSessions((items) => items.map((session) => session.id === selectedRecapId ? { ...session, analysis } : session))
      setRecapNotice('Recap refreshed from saved session messages.')
    } catch (error) { setRecapError(error instanceof Error ? error.message : 'Session analysis could not be completed.') }
    finally { setRecapBusy(false) }
  }

  async function pollApi(path: string, method = 'GET', payload?: unknown): Promise<SavedPoll | null> {
    const response = await fetch(path, {
      method,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      cache: 'no-store',
    })
    const result: unknown = await response.json()
    if (!response.ok) {
      const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Poll request failed.'
      throw new Error(message)
    }
    const poll = parseSavedPoll(result)
    if (poll === undefined) throw new Error('The poll response had an unexpected format.')
    return poll
  }

  useEffect(() => {
    if (connectionReadiness !== 'connected') return
    let current = true
    void pollApi('/twitch/polls/current').then((poll) => {
      if (current) {
        if (!pollEditorDirty.current && !pollMutationLocked.current) setSavedPoll(poll)
        setPollLoaded(true)
      }
    }).catch((error) => {
      if (current) setSavedPollError(error instanceof Error ? error.message : 'Could not load the current poll.')
    })
    return () => { current = false }
  }, [connectionReadiness])

  useEffect(() => {
    if (connectionReadiness !== 'connected' || pollBusy || !savedPoll || savedPoll.status === 'draft') return
    let mounted = true
    let requestInProgress = false
    let timer: ReturnType<typeof setInterval> | undefined
    let activeRequest: AbortController | null = null
    async function refreshResults(): Promise<void> {
      if (!mounted || requestInProgress) return
      requestInProgress = true
      const controller = new AbortController()
      activeRequest = controller
      try {
        const [response, statusResponse] = await Promise.all([
          fetch('/twitch/polls/results', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) }),
          fetch('/twitch/polls/status', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) }),
        ])
        const [result, statusResult]: [unknown, unknown] = await Promise.all([response.json(), statusResponse.json()])
        if (!response.ok || !statusResponse.ok) throw new Error('Live poll results could not be refreshed.')
        const poll = parseSavedPoll(result)
        if (poll === undefined) throw new Error('The live poll response had an unexpected format.')
        const status = parseVoteStatus(statusResult)
        if (!status) throw new Error('The poll status response had an unexpected format.')
        if (mounted) {
          // Refresh this displayed result only. Never replace a local editor or
          // switch to a different poll merely because the result endpoint changed.
          if (poll?.id === savedPoll?.id && !pollEditorDirty.current) setSavedPoll(poll)
          setVoteStatus(status)
          setPollResultsError('')
        }
      } catch {
        if (mounted && !controller.signal.aborted) setPollResultsError('Live results are temporarily unavailable. Showing the last saved totals.')
      } finally { requestInProgress = false }
    }
    void refreshResults()
    timer = setInterval(() => { void refreshResults() }, 1_000)
    return () => {
      mounted = false
      if (timer) clearInterval(timer)
      activeRequest?.abort()
    }
  }, [connectionReadiness, pollBusy, savedPoll?.status, savedPoll?.id])

  async function savePollDraft(question = pollQuestion, options = pollOptions, existingId: string | null = savedPoll?.status === 'draft' ? savedPoll.id : null, activate = false) {
    if (pollMutationLocked.current || !isValidPollInput(question, options)) return null
    pollMutationLocked.current = true
    setPollBusy(true)
    setSavedPollError('')
    try {
      let poll = await pollApi(existingId ? `/twitch/polls/${encodeURIComponent(existingId)}` : '/twitch/polls', existingId ? 'PATCH' : 'POST', { question, options })
      if (!poll) throw new Error('The server did not return the saved draft. Please refresh before retrying.')
      setSavedPoll(poll)
      pollEditorDirty.current = false
      // One explicit Start action, while preserving the backend draft/activation
      // validation. A failed activation leaves the saved draft available to retry.
      if (activate) {
        poll = await pollApi(`/twitch/polls/${encodeURIComponent(poll.id)}/activate`, 'POST')
        if (!poll) throw new Error('Poll activation could not be confirmed. Refresh the dashboard before retrying.')
        setSavedPoll(poll)
      }
      return poll
    } catch (error) {
      setSavedPollError(error instanceof Error ? error.message : 'Could not save the poll draft.')
      return null
    } finally { pollMutationLocked.current = false; setPollBusy(false) }
  }

  async function changePollState(action: 'activate' | 'close') {
    if (!savedPoll || pollMutationLocked.current) return
    if (action === 'activate') {
      await savePollDraft(savedPoll.question, savedPoll.options.map((option) => option.text), savedPoll.id, true)
      return
    }
    pollMutationLocked.current = true
    setPollBusy(true)
    setSavedPollError('')
    try {
      const poll = await pollApi(`/twitch/polls/${encodeURIComponent(savedPoll.id)}/${action}`, 'POST')
      if (poll) setSavedPoll(poll)
    } catch (error) {
      setSavedPollError(error instanceof Error ? error.message : 'Could not update poll status.')
    } finally { pollMutationLocked.current = false; setPollBusy(false) }
  }

  function createAnotherPoll() {
    pollEditorDirty.current = true
    setSavedPoll(null)
    setPollQuestion('')
    setPollOptions(['', ''])
    setSavedPollError('')
    setPollResultsError('')
    setVoteStatus(null)
    document.getElementById('manual-poll-question')?.focus()
  }

  async function signOut() {
    if (signOutBusy) return
    setSignOutBusy(true)
    setAuthError('')
    setAuthNotice('')
    accountGeneration.current += 1
    try {
      const response = await fetch('/twitch/logout', { method: 'POST', cache: 'no-store' })
      const result: unknown = await response.json()
      if (!response.ok || !result || typeof result !== 'object' || !('signedOut' in result) || result.signedOut !== true) {
        throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Sign out could not be confirmed. Please try again.')
      }
      setAuthorizationState('signed_out')
      setConnectionReadiness('disconnected')
      setFeedState('issue')
      setFeedDetail('Signed out. Sign in with Twitch to resume capture.')
      realMessageMode.current = false
      setUsingRealMessages(false)
      setChatMessages([])
      setRecapSessions([])
      setSavedPoll(null)
      setPollLoaded(false)
      setPollQuestion('')
      setPollOptions(['', ''])
      pollEditorDirty.current = false
      setVoteStatus(null)
      setQuestionStatuses(readQuestionStatuses())
      setQuestionPriorities({})
      setPulseResult(null)
      setPollDrafts({})
      setChatWriteEnabled(false)
      setSessionPersistenceIssue(false)
      setAuthNotice('Signed out of ChatBeacon. Chat capture and voting are paused; saved sessions and polls are kept. Twitch’s app permission remains until you remove it in Twitch Connections.')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign out could not be completed. Please try again.')
    } finally { setSignOutBusy(false) }
  }

  async function announceSavedPoll() {
    if (!savedPoll || savedPoll.status !== 'active') return
    setPollBusy(true)
    setSavedPollError('')
    try {
      const poll = await pollApi(`/twitch/polls/${encodeURIComponent(savedPoll.id)}/announce`, 'POST')
      if (poll) setSavedPoll(poll)
    } catch (error) {
      setSavedPollError(error instanceof Error ? error.message : 'Could not announce this poll in chat.')
    } finally { setPollBusy(false) }
  }

  useEffect(() => {
    const currentUrl = new URL(window.location.href)
    if (!currentUrl.searchParams.has('twitch')) return
    currentUrl.searchParams.delete('twitch')
    window.history.replaceState({}, document.title, `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`)
  }, [])

  useEffect(() => () => {
    pulseRequest.current?.abort()
    for (const controller of pollRequests.current.values()) controller.abort()
  }, [])

  async function analyzePulse() {
    if (pulseRequestLocked.current || pollRequests.current.size > 0 || !usingRealMessages || chatMessages.length === 0) return
    pulseRequestLocked.current = true
    const controller = new AbortController()
    pulseRequest.current = controller
    setPulseLoading(true)
    setPulseError('')
    try {
      const response = await fetch('/community-pulse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages.slice(-50) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(26_000)]),
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        const errorText = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
          ? result.error
          : 'Community Pulse could not complete. Try again later.'
        throw new Error(errorText)
      }
      if (!result || typeof result !== 'object' || !('pulse' in result) || !('provider' in result)) {
        throw new Error('The analysis response had an unexpected format.')
      }
      setPulseResult(result as CommunityPulseResult)
    } catch (error) {
      if (!controller.signal.aborted) {
        setPulseError(error instanceof Error && error.name === 'TimeoutError'
          ? 'Analysis took too long. Please try again.'
          : error instanceof Error ? error.message : 'Community Pulse could not complete. Try again later.')
      }
    } finally {
      pulseRequestLocked.current = false
      if (!controller.signal.aborted) setPulseLoading(false)
    }
  }

  function topicKey(topic: CommunityPulseTopic): string {
    return topic.messageIds.join('|')
  }

  async function suggestPoll(topic: CommunityPulseTopic) {
    const key = topicKey(topic)
    if (pulseRequestLocked.current || pollRequests.current.size > 0) return
    const controller = new AbortController()
    pollRequests.current.set(key, controller)
    setPollLoading((current) => ({ ...current, [key]: true }))
    setPollErrors((current) => ({ ...current, [key]: '' }))
    try {
      const response = await fetch('/community-pulse/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: { title: topic.title, explanation: topic.explanation, messageIds: topic.messageIds },
          messages: chatMessages.filter((message) => topic.messageIds.includes(message.messageId)),
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(26_000)]),
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
          ? result.error
          : 'Could not create a poll suggestion. Please try again.'
        throw new Error(message)
      }
      if (!result || typeof result !== 'object' || !('suggestion' in result) || !('provider' in result)) {
        throw new Error('The poll suggestion response had an unexpected format.')
      }
      const payload = result as { provider: string; suggestion: { question: string; options: string[]; explanation: string; messageIds: string[] } }
      if (!isValidPollInput(payload.suggestion.question, payload.suggestion.options)) {
        throw new Error('The suggestion needs a valid question and 2–4 distinct options. Please try again.')
      }
      setPollDrafts((current) => ({
        ...current,
        [key]: { ...payload.suggestion, provider: payload.provider, edited: false, approved: false },
      }))
    } catch (error) {
      if (!controller.signal.aborted) {
        setPollErrors((current) => ({
          ...current,
          [key]: error instanceof Error && error.name === 'TimeoutError'
            ? 'Poll suggestion took too long. Please try again.'
            : error instanceof Error ? error.message : 'Could not create a poll suggestion. Please try again.',
        }))
      }
    } finally {
      pollRequests.current.delete(key)
      if (!controller.signal.aborted) setPollLoading((current) => ({ ...current, [key]: false }))
    }
  }

  function editPoll(topicId: string, update: (draft: PollDraft) => PollDraft) {
    setPollDrafts((current) => {
      const draft = current[topicId]
      return draft ? { ...current, [topicId]: { ...update(draft), edited: true, approved: false } } : current
    })
  }

  useEffect(() => {
    if (usingRealMessages) return
    try {
      window.localStorage.setItem(questionStatusStorageKey, JSON.stringify(questionStatuses))
    } catch {
      // The dashboard still works for this session if browser storage is unavailable.
    }
  }, [questionStatuses, usingRealMessages])

  useEffect(() => {
    let mounted = true
    let requestInProgress = false
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let activeRequest: AbortController | null = null

    async function pollChat(): Promise<void> {
      if (!mounted || requestInProgress) return
      requestInProgress = true
      const generation = accountGeneration.current
      const controller = new AbortController()
      activeRequest = controller
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])

      try {
        const [messagesResult, statusResult] = await Promise.allSettled([
          fetch('/twitch/messages', { signal: requestSignal, cache: 'no-store' }),
          fetch('/twitch/status', { signal: requestSignal, cache: 'no-store' }),
        ])

        let statusData: unknown = null
        if (statusResult.status === 'fulfilled' && statusResult.value.ok) {
          try { statusData = await statusResult.value.json() } catch { statusData = null }
        }
        const validStatus = isTwitchStatus(statusData) ? statusData : null
        if (!mounted || generation !== accountGeneration.current) return
        if (validStatus) setAuthorizationState(validStatus.authorization?.state ?? (validStatus.state === 'connected' ? 'signed_in' : 'unknown'))
        if (!validStatus) {
          setConnectionReadiness('unknown')
        } else if (validStatus.state === 'connected' && validStatus.subscription === 'enabled') {
          setConnectionReadiness('connected')
        } else if (validStatus.state === 'connecting' || validStatus.subscription === 'pending') {
          setConnectionReadiness('connecting')
        } else {
          setConnectionReadiness('disconnected')
        }
        if (validStatus) setChatWriteEnabled(validStatus.chatWriteEnabled === true)
        if (validStatus) setSessionPersistenceIssue(validStatus.sessionPersistence?.historyMayBeIncomplete === true || validStatus.sessionPersistence?.state === 'degraded')

        if (messagesResult.status === 'rejected') throw messagesResult.reason
        const messagesResponse = messagesResult.value
        if (!messagesResponse.ok) throw new Error('messages request failed')
        const messagesData: unknown = await messagesResponse.json()
        const latestMessages = parseMessagesResponse(messagesData)
        if (!latestMessages) throw new Error('unexpected messages response')
        if (!mounted || generation !== accountGeneration.current) return

        setChatMessages((previous) => mergeChatHistory(previous, latestMessages))
        const subscriptionActive = validStatus?.state === 'connected' && validStatus.subscription === 'enabled'
        if (!subscriptionActive) {
          if (realMessageMode.current) setMessagesStale(true)
          const subscriptionPending = validStatus?.state === 'connecting' || validStatus?.subscription === 'pending'
          setFeedState(subscriptionPending ? 'connecting' : 'issue')
          setFeedDetail(subscriptionPending
            ? 'Waiting for the Twitch chat subscription to finish connecting.'
            : validStatus?.authorization?.state === 'signed_out'
              ? 'Signed out. Sign in with Twitch to resume capture.'
            : validStatus?.authorization?.message
              ? validStatus.authorization.message
            : validStatus
              ? 'The backend is available, but the Twitch chat subscription is not active.'
              : 'Chat data was fetched, but the Twitch subscription status could not be checked.')
          return
        }

        realMessageMode.current = true
        setUsingRealMessages(true)
        setLastUpdatedAt(new Date())
        setMessagesStale(false)
        setFeedState('live')
        setFeedDetail('Twitch subscription active · polling every second')
      } catch {
        if (!mounted || generation !== accountGeneration.current) return
        if (realMessageMode.current) setMessagesStale(true)
        setFeedState('issue')
        setFeedDetail(realMessageMode.current
          ? 'Could not refresh chat. Showing the last messages received.'
          : 'Could not reach the backend. Showing clearly marked sample messages.')
      } finally {
        requestInProgress = false
      }
    }

    void pollChat()
    pollTimer = setInterval(() => { void pollChat() }, 1_000)
    return () => {
      mounted = false
      if (pollTimer) clearInterval(pollTimer)
      activeRequest?.abort()
    }
  }, [])

  const activeSession = recapSessions.find((session) => session.status === 'active')
  const questions = useMemo(
    () => groupQuestions(usingRealMessages ? chatMessages : demoQuestionMessages, questionStatuses, usingRealMessages ? 'live' : 'demo',
      usingRealMessages && activeSession ? { broadcasterId: activeSession.broadcasterId, sessionId: activeSession.id } : undefined, questionPriorities),
    [activeSession?.broadcasterId, activeSession?.id, chatMessages, questionStatuses, questionPriorities, usingRealMessages],
  )
  const unansweredCount = questions.filter((question) => question.status === 'unanswered').length
  const answeredCount = questions.filter((question) => question.status === 'answered').length
  const followUpCount = questions.filter((question) => question.status === 'follow_up').length
  const visibleQuestions = sortQuestionsByPriority(questions.filter((question) => filter === 'all' || question.status === filter))
  const relatedQuestionSuggestions = useMemo(() => findRelatedQuestionSuggestions(questions), [questions])
  const chatAnnouncementSent = Boolean(savedPoll && voteStatus?.chatAnnouncement?.pollId === savedPoll.id && voteStatus.chatAnnouncement.result === 'sent')
  const selectedRecap = recapSessions.find((session) => session.id === selectedRecapId) ?? null
  const followUpQuestions = recapSessions.filter((session) => session.id !== activeSession?.id)
    .flatMap((session) => session.metrics.questions.filter((question) => question.status === 'follow_up').map((question) => ({ ...question, sessionId: session.id, sessionStartedAt: session.startedAt })))
  const overlayUrl = getPollOverlayUrl(window.location.origin)
  const overviewTiles = buildOverviewTiles({
    live: feedState === 'live',
    pendingQuestions: unansweredCount,
    communityAnalysisReady: Boolean(pulseResult && !pulseResult.pulse.insufficientData),
    pollStatus: savedPoll?.status ?? 'none',
    pollVotes: savedPoll?.totalVotes ?? 0,
    sessionCount: recapSessions.length,
    sessionActive: Boolean(activeSession),
  })

  async function copyOverlayUrl() {
    try {
      await navigator.clipboard.writeText(overlayUrl)
      setOverlayFeedback('Overlay URL copied. Add it as a Browser Source in OBS.')
    } catch {
      setOverlayFeedback('Copy was blocked by this browser. You can select and copy the URL below.')
    }
  }

  async function toggleQuestionStatus(id: string, nextStatus: 'open' | 'answered' | 'follow_up', sessionId = activeSession?.id) {
    if (!usingRealMessages || !sessionId) {
      setQuestionStatuses((current) => ({ ...current, [id]: nextStatus === 'open' ? 'unanswered' : nextStatus }))
      setQuestionActionMessage(nextStatus === 'open' ? 'Question reopened.' : nextStatus === 'follow_up' ? 'Question marked for follow-up.' : 'Question marked answered.')
      return
    }
    const previous = questionStatuses[id]
    setQuestionActionMessage('')
    setQuestionStatuses((current) => ({ ...current, [id]: nextStatus === 'open' ? 'unanswered' : nextStatus }))
    try {
      const response = await fetch(`/twitch/sessions/${encodeURIComponent(sessionId)}/questions/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: id, status: nextStatus }),
      })
      if (!response.ok) throw new Error()
      // Saving the status is the primary action. A later recap refresh failure
      // must not make an already accepted status change look unsuccessful.
      void refreshRecapSessions().catch(() => setRecapError('Your change was saved, but session history could not be refreshed.'))
      setQuestionActionMessage(nextStatus === 'open' ? 'Question reopened and saved.' : nextStatus === 'follow_up' ? 'Question marked for follow-up and saved.' : 'Question marked answered and saved.')
    } catch {
      setQuestionStatuses((current) => ({ ...current, [id]: previous ?? 'unanswered' }))
      setQuestionActionMessage('The question status could not be saved. Please try again.')
    }
  }

  async function toggleQuestionPriority(id: string) {
    if (!activeSession) return
    const priority = ((questionPriorities[id] ?? 0) + 1) % 3 as 0 | 1 | 2
    setQuestionActionMessage('')
    setQuestionPriorities((current) => ({ ...current, [id]: priority }))
    try {
      const response = await fetch(`/twitch/sessions/${encodeURIComponent(activeSession.id)}/questions/priority`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: id, priority }),
      })
      if (!response.ok) throw new Error()
      void refreshRecapSessions().catch(() => setRecapError('Your change was saved, but session history could not be refreshed.'))
      setQuestionActionMessage(priority === 2 ? 'Question priority set to high.' : priority === 1 ? 'Question priority raised.' : 'Question priority reset to standard.')
    } catch {
      setQuestionPriorities((current) => ({ ...current, [id]: (priority + 2) % 3 as 0 | 1 | 2 }))
      setQuestionActionMessage('Question priority could not be saved. Please try again.')
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to dashboard content</a>
      <header className="topbar">
        <a className="brand" href="#main-content" aria-label="ChatBeacon home">
          <BeaconMark />
          <span>Chat<span className="brand-accent">Beacon</span></span>
        </a>

        <nav className="primary-nav" aria-label="Main sections">
          {dashboardNavigation.map((item) => <a key={item.id} href={`#${item.id}`}>{item.label}</a>)}
        </nav>

        <div className="topbar-right">
          <ThemeToggle />
          <span className="demo-badge"><span className="demo-dot" />{usingRealMessages ? 'Live mode' : 'Demo mode'} <span className="demo-divider">·</span> {usingRealMessages ? 'Twitch messages' : 'sample data'}</span>
          <div className="connection-status" aria-label="Twitch chat update status">
            <span className={`connection-dot connection-dot-${feedState}`} />
            <span className="connection-copy">
              <span className="connection-label">TWITCH CHAT</span>
              <span className="connection-state" role="status" aria-live="polite">
                {feedState === 'live' ? 'Live' : feedState === 'connecting' ? (usingRealMessages ? 'Reconnecting' : 'Connecting') : authorizationState === 'signed_out' ? 'Signed out' : 'Connection issue'}
              </span>
              <span className="connection-detail">{feedDetail}</span>
            </span>
            {authorizationState === 'signed_in' || authorizationState === 'error' ? (
              <><button className="connect-button" type="button" disabled={signOutBusy || pollBusy || pulseLoading || Object.values(pollLoading).some(Boolean) || recapBusy} onClick={() => void signOut()}>{signOutBusy ? 'Signing out…' : 'Sign out'}</button>
                {(!chatWriteEnabled || authorizationState === 'error') && <a className="connect-button" href="http://localhost:3001/auth/twitch/login">Sign in again</a>}</>
            ) : connectionReadiness === 'connecting' || feedState === 'connecting' ? (
              <button className="connect-button" type="button" disabled>Connecting…</button>
            ) : (
              <a className="connect-button" href="http://localhost:3001/auth/twitch/login">Sign in with Twitch</a>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="dashboard">
        <section id="overview" className="overview-section" aria-labelledby="welcome-title">
        <div className="welcome-row">
          <div>
            <p className="eyebrow"><span className="eyebrow-line" />STREAMER WORKSPACE</p>
            <h1 id="welcome-title">Keep up with what chat is asking <span aria-hidden="true">✦</span></h1>
            <p className="welcome-copy">ChatBeacon surfaces recurring questions, tracks follow-ups, and helps you choose what to act on.</p>
          </div>
          <div className="sample-note onboarding-note">
            <span className="sample-note-icon" aria-hidden="true">✳</span>
            <span>{usingRealMessages
              ? <><strong>{feedState === 'live' ? 'Connected · real Twitch chat' : 'Twitch chat · capture paused'}</strong><br />{feedState === 'live' ? 'Your approved Twitch connection is active. New chat appears automatically.' : 'Last received messages remain visible while the connection recovers.'}</>
              : connectionReadiness === 'connecting'
                ? <><strong>Checking your connection</strong><br />Sample chat remains separate until Twitch chat is confirmed.</>
                : feedDetail.startsWith('Could not reach the backend')
                  ? <><strong>Start the local backend</strong><br />In the backend folder, run <code>npm run dev</code>, then refresh. Twitch app settings belong in <code>backend/.env</code>; never paste secrets here.</>
                  : <><strong>Demo mode · sample data</strong><br />Select Sign in with Twitch and approve chat access. Real questions appear only after the backend confirms the connection. Local Twitch settings stay in <code>backend/.env</code>.</>}</span>
          </div>
        </div>

        {oauthFeedback && (
          <p className={`oauth-feedback oauth-feedback-${oauthFeedback.tone}`} role="status" aria-live="polite">
            {oauthFeedback.text}
          </p>
        )}
        {authError && <p className="poll-error" role="alert">{authError}</p>}
        {authNotice && <p className="oauth-feedback" role="status">{authNotice} <a href="https://www.twitch.tv/settings/connections" target="_blank" rel="noreferrer">Manage Twitch app permissions</a></p>}
        {sessionPersistenceIssue && <p className="capture-warning" role="status">Chat is still being tracked, but session storage is degraded. Saved history may be incomplete while storage recovers.</p>}

        <section className="summary-grid" aria-label="Question summary">
          <article className="summary-card summary-total">
            <div className="summary-topline"><span className="summary-icon icon-total" aria-hidden="true">◎</span><span className="summary-caption">IN THE QUEUE</span></div>
            <strong>{questions.length}</strong>
            <span className="summary-label">Questions tracked</span>
          </article>
          <article className="summary-card">
            <div className="summary-topline"><span className="summary-icon icon-open" aria-hidden="true">◷</span><span className="summary-caption">NEEDS A REPLY</span></div>
            <strong>{unansweredCount}</strong>
            <span className="summary-label">Unanswered</span>
          </article>
          <article className="summary-card">
            <div className="summary-topline"><span className="summary-icon icon-done" aria-hidden="true">✓</span><span className="summary-caption">NICE WORK</span></div>
            <strong>{answeredCount}</strong>
            <span className="summary-label">Answered</span>
          </article>
        </section>

        <div className="overview-grid" aria-label="Dashboard overview">
          <h2 className="visually-hidden">At a glance</h2>
          {overviewTiles.map((tile) => <a className="overview-tile" href={tile.href} key={tile.id}>
            <span>{tile.label}</span><strong>{tile.value}</strong><small>{tile.detail}</small>
          </a>)}
        </div>
        </section>

        <div id="chat-tracker" className="panels-grid">
          <section className="panel chat-panel" aria-labelledby="chat-title">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="panel-icon chat-icon" aria-hidden="true">▤</span>
                <div>
                  <h2 id="chat-title">Live chat</h2>
                  <p className="panel-subtitle">{usingRealMessages ? 'Newest Twitch messages first' : 'A glimpse of the conversation'}</p>
                </div>
              </div>
              <span className={`sample-label ${usingRealMessages ? 'live-chat-label' : ''}`}>
                <span className="sample-label-dot" />{usingRealMessages ? 'TWITCH CHAT' : 'SAMPLE'}
              </span>
            </div>

            <div className={`chat-list ${usingRealMessages ? 'chat-list-live' : ''}`} aria-label={usingRealMessages ? 'Twitch chat messages, newest first' : 'Sample chat messages'} aria-live="off">
              {usingRealMessages ? chatMessages.length > 0 ? [...chatMessages].reverse().map((message) => (
                <article className="chat-message" key={message.messageId}>
                  <span className="avatar avatar-live" aria-hidden="true">{message.chatterName.slice(0, 1).toUpperCase()}</span>
                  <div className="chat-message-body">
                    <div className="chat-meta"><span className="chat-username">{message.chatterName}</span><time dateTime={message.timestamp}>{messageTime(message.timestamp)}</time></div>
                    <p>{message.text}</p>
                  </div>
                </article>
              )) : (
                <div className="chat-empty-state">
                  <strong>No Twitch messages received yet</strong>
                  <span>New channel messages will appear here.</span>
                </div>
              ) : sampleChatMessages.map((message) => (
                <article className="chat-message" key={message.name}>
                  <span className={`avatar avatar-${message.tone}`} aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
                  <div className="chat-message-body">
                    <div className="chat-meta"><span className="chat-username">{message.name}</span><time>{message.time}</time></div>
                    <p>{message.text}</p>
                  </div>
                </article>
              ))}
            </div>

            <div className="chat-footer">
              <span className="footer-spark" aria-hidden="true">✦</span>
              {usingRealMessages
                ? messagesStale && lastUpdatedAt
                  ? `Chat data is stale · last fetched at ${lastUpdatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                  : lastUpdatedAt
                    ? `Chat data checked at ${lastUpdatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · polling about once per second`
                    : 'Twitch messages · polling about once per second'
                : 'Demo messages for layout preview'}
            </div>
          </section>

          <section className="panel questions-panel" aria-labelledby="questions-title">
            <div className="panel-heading questions-heading">
              <div className="panel-title-wrap">
                <span className="panel-icon question-icon" aria-hidden="true">?</span>
                <div>
                  <h2 id="questions-title">Questions to track</h2>
                  <p className="panel-subtitle">{usingRealMessages ? 'Likely questions · exact repeats grouped' : 'Demo messages processed with the same rules'}</p>
                </div>
              </div>
              <span className="question-count">{questions.length} <span>total</span></span>
            </div>

            <div className="filter-tabs" role="group" aria-label="Filter questions by status">
              {filters.map((option) => {
                const count = option.id === 'all' ? questions.length : option.id === 'answered' ? answeredCount : option.id === 'follow_up' ? followUpCount : unansweredCount
                return (
                  <button
                    className={`filter-tab ${filter === option.id ? 'filter-tab-active' : ''}`}
                    type="button"
                    key={option.id}
                    onClick={() => setFilter(option.id)}
                    aria-pressed={filter === option.id}
                  >
                    {option.label}<span className="filter-count">{count}</span>
                  </button>
                )
              })}
            </div>

            <div className="question-list" aria-live="off">
              {questionActionMessage && <p className={questionActionMessage.includes('could not be saved') ? 'question-action-feedback question-action-error' : 'question-action-feedback'} role={questionActionMessage.includes('could not be saved') ? 'alert' : 'status'} aria-live={questionActionMessage.includes('could not be saved') ? 'assertive' : 'polite'}>{questionActionMessage}</p>}
              {visibleQuestions.length > 0 ? visibleQuestions.map((question) => (
                <article className={`question-card question-${question.status}`} key={question.id}>
                  <div className="question-card-top">
                      <span className={`status-tag status-${question.status}`}>
                      <span className="status-dot" />{question.status === 'answered' ? 'Answered' : question.status === 'follow_up' ? 'Follow up' : 'Open'}
                    </span>
                    <span className="status-tag" aria-label={`Priority ${question.manualPriority + 1} of 3`}>{question.manualPriority === 2 ? 'High priority' : question.manualPriority === 1 ? 'Raised' : 'Standard'}</span>
                    <div className="question-seen-times">
                      <time className="question-time" dateTime={question.firstSeenAt}>First {questionSeenTime(question.firstSeenAt)}</time>
                      <time className="question-time" dateTime={question.lastSeenAt}>Last {questionSeenTime(question.lastSeenAt)}</time>
                    </div>
                  </div>
                  <p className="question-text">{question.text}</p>
                  {relatedQuestionSuggestions.get(question.id)?.[0] && <p className="question-related-hint">Possibly related wording (kept as a separate question): {questions.find((item) => item.id === relatedQuestionSuggestions.get(question.id)?.[0])?.text}</p>}
                  <div className="question-card-bottom">
                    <div className="question-details">
                      <span className="question-author-avatar" aria-hidden="true">{question.authors[0]?.slice(0, 1).toUpperCase() ?? '?'}</span>
                      <span className="question-author" title={question.authors.join(', ')}>
                        {question.authors.length > 2
                          ? `${question.authors[0]}, ${question.authors[1]} +${question.authors.length - 2}`
                          : question.authors.join(', ')}
                      </span>
                      <span className="detail-separator">·</span>
                      <span className="similar-count">Asked {question.messageIds.length} {question.messageIds.length === 1 ? 'time' : 'times'} · {question.authors.length} {question.authors.length === 1 ? 'chatter' : 'chatters'}</span>
                    </div>
                    {question.status === 'answered'
                      ? <button className="status-action status-action-reopen" type="button" onClick={() => void toggleQuestionStatus(question.id, 'open')} aria-label="Reopen question">↶ Reopen</button>
                      : question.status === 'follow_up'
                        ? <><button className="status-action" type="button" onClick={() => void toggleQuestionStatus(question.id, 'answered')} aria-label="Mark follow-up question answered">✓ Answered</button><button className="status-action status-action-reopen" type="button" onClick={() => void toggleQuestionStatus(question.id, 'open')} aria-label="Return follow-up question to open">↶ Reopen</button></>
                        : <><button className="status-action" type="button" onClick={() => void toggleQuestionStatus(question.id, 'answered')} aria-label="Mark question answered">✓ Answered</button><button className="status-action" type="button" onClick={() => void toggleQuestionStatus(question.id, 'follow_up')} aria-label="Mark question for follow-up">Follow up</button></>}
                    {usingRealMessages && activeSession && <button className="status-action" type="button" onClick={() => void toggleQuestionPriority(question.id)} aria-label={`Set priority: ${question.manualPriority === 2 ? 'High' : question.manualPriority === 1 ? 'Raised' : 'Standard'} for ${question.text}; current priority ${question.manualPriority + 1} of 3`}>Set priority: {question.manualPriority === 2 ? 'High' : question.manualPriority === 1 ? 'Raised' : 'Standard'}</button>}
                  </div>
                </article>
              )) : (
                <div className="empty-state">
                  <span className="empty-icon" aria-hidden="true">☼</span>
                  <h3>{questions.length === 0 ? 'No likely questions yet' : 'All caught up'}</h3>
                  <p>{questions.length === 0
                    ? 'No chat messages have matched the question rules so far.'
                    : `There are no ${filter} questions right now. Try another filter to see more.`}</p>
                </div>
              )}
            </div>
            <p className="questions-footnote">Queue order weighs manual priority, distinct chat authors (capped), and recency. Repeating a question does not inflate its author count.</p>
            {followUpQuestions.length > 0 && <div className="follow-up-list" aria-labelledby="follow-up-title"><h3 id="follow-up-title">Follow-up from previous streams</h3>{followUpQuestions.map((question) => <article className="question-card question-unanswered" key={question.id}><p className="question-text">{question.text}</p><p className="recap-muted">Original stream: {new Date(question.sessionStartedAt).toLocaleString()} · {question.count} message{question.count === 1 ? '' : 's'}</p><button className="status-action" type="button" onClick={() => void toggleQuestionStatus(question.id, 'answered', question.sessionId)}>Mark answered</button></article>)}</div>}
            <p className="questions-footnote"><span aria-hidden="true">ⓘ</span> Questions are grouped by exact normalized text. Possible schedule paraphrases stay separate; live status and priority are saved with the original stream.</p>
          </section>
        </div>
        <section id="community-pulse" className="panel pulse-panel" aria-labelledby="pulse-title">
          <div className="panel-heading pulse-heading">
            <div className="panel-title-wrap">
              <span className="panel-icon pulse-icon" aria-hidden="true">✦</span>
              <div>
                <h2 id="pulse-title">Community Pulse</h2>
                <p className="panel-subtitle">Understand what your viewers are talking about</p>
              </div>
            </div>
            <button className="pulse-button" type="button" onClick={() => void analyzePulse()} disabled={!usingRealMessages || chatMessages.length === 0 || pulseLoading || Object.values(pollLoading).some(Boolean)}>
              {pulseLoading ? 'Analyzing…' : pulseResult ? 'Refresh analysis' : 'Analyze chat'}
            </button>
          </div>
          <div className="pulse-content" aria-live="polite" aria-busy={pulseLoading}>
            {!usingRealMessages ? (
              <div className="pulse-empty"><strong>Waiting for live chat</strong><p>Connect Twitch and receive real messages to create a Community Pulse. Sample messages are never sent for analysis.</p></div>
            ) : pulseLoading ? (
              <p className="pulse-muted pulse-loading" role="status">Reviewing up to 50 recent messages…</p>
            ) : pulseError ? (
              <div className="pulse-error" role="alert"><span>{pulseError}</span><button type="button" onClick={() => void analyzePulse()}>Try again</button></div>
            ) : pulseResult ? (
              pulseResult.pulse.insufficientData ? (
                <div className="pulse-empty"><strong>Not enough evidence yet</strong><p>{pulseResult.pulse.insufficientReason}</p></div>
              ) : (
                <>
                  <div className="pulse-summary-row">
                    <p className="pulse-summary">{pulseResult.pulse.overallSummary}</p>
                    <span className="pulse-source">Recent chat · {pulseResult.provider}</span>
                  </div>
                  {pulseResult.pulse.topics.length > 0 ? <div className="pulse-results-grid">
                    {pulseResult.pulse.topics.map((topic) => {
                      const key = topicKey(topic)
                      const draft = pollDrafts[key]
                      return <article className="pulse-topic" key={key}>
                        <div className="pulse-topic-title"><span className="pulse-topic-kicker">RECURRING TOPIC</span><h3>{topic.title}</h3></div>
                        <p>{topic.explanation}</p>
                        <div className="pulse-evidence">
                          <h4>Supporting messages</h4>
                          {topic.representativeMessages.map((message) => <blockquote key={message.messageId}>
                            <p>“{message.text}”</p><cite>{message.chatterName} · {messageTime(message.timestamp)}</cite>
                          </blockquote>)}
                        </div>
                        {!draft ? (
                          <div className="poll-action-area">
                            <button className="poll-suggest-button" type="button" onClick={() => void suggestPoll(topic)} disabled={pulseLoading || Object.values(pollLoading).some(Boolean)}>
                              {pollLoading[key] ? 'Creating suggestion…' : 'Suggest a poll'}
                            </button>
                            {pollErrors[key] && <p className="poll-error" role="alert">{pollErrors[key]} <button type="button" onClick={() => void suggestPoll(topic)}>Try again</button></p>}
                          </div>
                        ) : (
                          <div className="poll-editor">
                            <div className="poll-editor-heading"><h4>Poll draft</h4><span>AI suggestion · review before saving</span></div>
                            {pollErrors[key] && <p className="poll-error" role="alert">{pollErrors[key]}</p>}
                            <label htmlFor={`poll-question-${key}`}>Poll question</label>
                            <input id={`poll-question-${key}`} maxLength={140} value={draft.question} disabled={pollBusy} onChange={(event) => editPoll(key, (current) => ({ ...current, question: event.target.value }))} />
                            <fieldset disabled={pollBusy}>
                              <legend>Answer options</legend>
                              {draft.options.map((option, index) => <div className="poll-option-row" key={`${key}-option-${index}`}>
                                <input aria-label={`Poll answer option ${index + 1}`} maxLength={60} value={option} onChange={(event) => editPoll(key, (current) => ({ ...current, options: current.options.map((value, optionIndex) => optionIndex === index ? event.target.value : value) }))} />
                                {draft.options.length > 2 && <button type="button" className="poll-remove-option" aria-label={`Remove answer option ${index + 1}`} onClick={() => editPoll(key, (current) => ({ ...current, options: current.options.filter((_, optionIndex) => optionIndex !== index) }))}>Remove</button>}
                              </div>)}
                              {draft.options.length < 4 && <button className="poll-add-option" type="button" onClick={() => editPoll(key, (current) => ({ ...current, options: [...current.options, ''] }))}>+ Add option</button>}
                            </fieldset>
                            <p className="poll-why"><strong>Why this could work:</strong> {draft.explanation}</p>
                            {!draft.edited && <p className="poll-edit-hint">Review the question and options. Editing is optional. Start the poll when ready, or save it for later.</p>}
                            {!draft.approved && <button className="poll-approve-button" type="button" disabled={!isValidPollInput(draft.question, draft.options) || pollBusy || savedPoll?.status === 'active' || connectionReadiness !== 'connected'} onClick={async () => {
                              if (pollEditorDirty.current && !window.confirm('Replace your unsaved manual poll edits with this suggestion?')) return
                              const poll = await savePollDraft(draft.question, draft.options, null, true)
                              if (poll) setPollDrafts((current) => ({ ...current, [key]: { ...current[key]!, approved: true, activated: true } }))
                              else setPollErrors((current) => ({ ...current, [key]: 'Poll was not started. Your suggestion is kept here; check Beacon Pulse for details.' }))
                            }}>Start this poll</button>}
                            {!draft.approved ? <button className="poll-suggest-button" type="button" disabled={!isValidPollInput(draft.question, draft.options) || pollBusy || savedPoll?.status === 'active' || connectionReadiness !== 'connected'} onClick={async () => {
                              if (pollEditorDirty.current && !window.confirm('Replace your unsaved manual poll edits with this suggestion?')) return
                              const poll = await savePollDraft(draft.question, draft.options, null)
                              if (poll) setPollDrafts((current) => ({ ...current, [key]: { ...current[key]!, approved: true } }))
                              else setPollErrors((current) => ({ ...current, [key]: 'Draft was not saved. Your edits are still here; check Beacon Pulse for the server error before trying again.' }))
                            }}>{pollBusy ? 'Saving draft…' : 'Save as poll draft'}</button> : <p className="poll-approved" role="status">{draft.activated ? 'Poll started. Follow votes and close it in Beacon Pulse.' : 'Saved as a draft. It has not been published; activate it in Beacon Pulse when ready.'}</p>}
                            <button className="poll-regenerate" type="button" onClick={() => {
                              if (draft.edited && !window.confirm('Replace your edited suggestion with a new one?')) return
                              void suggestPoll(topic)
                            }} disabled={pulseLoading || Object.values(pollLoading).some(Boolean)}>{pollLoading[key] ? 'Creating…' : 'Generate a new draft'}</button>
                          </div>
                        )}
                      </article>
                    })}
                  </div> : <div className="pulse-empty"><strong>No recurring topics found</strong><p>Try refreshing after more viewers have chatted.</p></div>}
                  {pulseResult.pulse.recurringQuestions.length > 0 && <div className="pulse-questions">
                    <div className="pulse-section-heading"><h3>Recurring questions and requests</h3><span>{pulseResult.pulse.recurringQuestions.length}</span></div>
                    {pulseResult.pulse.recurringQuestions.map((question) => <article className="pulse-question-row" key={question.messageIds.join('|')}>
                      <p>{question.text}</p><div>{question.representativeMessages.map((message) => <span key={message.messageId}>{message.chatterName}: “{message.text}”</span>)}</div>
                    </article>)}
                  </div>}
                  <p className="pulse-provider">Based on this request’s batch, not a live trend metric. Confidence scores are omitted to avoid false precision.</p>
                </>
              )
            ) : (
              <div className="pulse-empty"><strong>Ready when you are</strong><p>Analyze up to 50 recent messages. Nothing is sent to an AI provider until you ask.</p></div>
            )}
          </div>
        </section>
        <section id="beacon-pulse" className="panel beacon-pulse-panel" aria-labelledby="beacon-pulse-title">
          <div className="panel-heading pulse-heading"><div className="panel-title-wrap"><span className="panel-icon pulse-icon" aria-hidden="true">◉</span><div><h2 id="beacon-pulse-title">Beacon Pulse</h2><p className="panel-subtitle">Prepare a chat poll for your viewers</p></div></div><span className={`poll-status-badge poll-status-${savedPoll?.status ?? 'draft'}`}>{savedPoll?.status ?? 'no poll'}</span></div>
          <div className="beacon-pulse-content">
            {connectionReadiness !== 'connected' ? <div className="pulse-empty"><strong>Connect Twitch to manage polls</strong><p>Poll drafts are saved for your connected channel.</p></div> : !pollLoaded ? <div className="pulse-empty" role="status"><p>{savedPollError || 'Loading your channel’s poll…'}</p>{savedPollError && <button type="button" onClick={() => { setSavedPollError(''); void pollApi('/twitch/polls/current').then((poll) => { setSavedPoll(poll); setPollLoaded(true) }).catch(() => setSavedPollError('Could not load the current poll. Please try again.')) }}>Retry loading poll</button>}</div> : <>
              {savedPollError && <p className="poll-error" role="alert">{savedPollError}</p>}
              {pollResultsError && <p className="poll-results-stale" role="status">{pollResultsError}</p>}
              {!chatWriteEnabled && <p className="poll-results-stale" role="status">Chat voting works, but Twitch chat announcements and replies are disabled. Reconnect Twitch and approve the chat-sending permission to enable them.</p>}
              {savedPoll && voteStatus?.voteFeedback?.pollId === savedPoll.id && <p className="poll-vote-feedback" role="status">{voteStatus.voteFeedback.kind === 'invalid_option' ? `An invalid vote was ignored. Use !vote 1 through !vote ${savedPoll.options.length}.` : 'A vote was ignored because this poll is closed.'}</p>}
              {savedPoll && voteStatus?.chatAnnouncement?.pollId === savedPoll.id && voteStatus.chatAnnouncement.result === 'sent' && <p className="poll-vote-feedback" role="status">The poll and its options were announced in Twitch chat.</p>}
              {savedPoll && voteStatus?.chatAnnouncement?.pollId === savedPoll.id && voteStatus.chatAnnouncement.result === 'failed' && <p className="poll-results-stale" role="status">The poll is active, but Twitch did not accept the chat announcement. Viewers can still vote using the displayed command.</p>}
              <div className="beacon-poll-form">
                <label htmlFor="manual-poll-question">Poll question</label><input id="manual-poll-question" maxLength={140} value={savedPoll ? savedPoll.question : pollQuestion} onChange={(event) => {
                  pollEditorDirty.current = true
                  if (savedPoll) setSavedPoll((current) => updateDraftPollQuestion(current, event.target.value))
                  else setPollQuestion(event.target.value)
                }} placeholder="What should we play next?" disabled={pollBusy || savedPoll?.status === 'active' || savedPoll?.status === 'closed'} />
                <fieldset disabled={pollBusy}><legend>Answer options (2–4)</legend>{(savedPoll ? savedPoll.options.map((option) => option.text) : pollOptions).map((option, index) => <div className="poll-option-row" key={savedPoll ? savedPoll.options[index]?.id : index}><input aria-label={`Poll answer option ${index + 1}`} maxLength={60} value={option} disabled={savedPoll?.status === 'active' || savedPoll?.status === 'closed'} onChange={(event) => {
                  pollEditorDirty.current = true
                  if (savedPoll?.status === 'draft') setSavedPoll({ ...savedPoll, options: savedPoll.options.map((item, optionIndex) => optionIndex === index ? { ...item, text: event.target.value } : item) })
                  else setPollOptions((items) => items.map((item, optionIndex) => optionIndex === index ? event.target.value : item))
                }} />{!savedPoll && pollOptions.length > 2 && <button type="button" className="poll-remove-option" aria-label={`Remove answer option ${index + 1}`} onClick={() => { pollEditorDirty.current = true; setPollOptions((items) => items.filter((_, optionIndex) => optionIndex !== index)) }}>Remove</button>}</div>)}
                  {!savedPoll && pollOptions.length < 4 && <button className="poll-add-option" type="button" onClick={() => { pollEditorDirty.current = true; setPollOptions((items) => [...items, '']) }}>+ Add option</button>}
                </fieldset>
                <div className="beacon-poll-preview"><span>PREVIEW</span><strong>{savedPoll?.question ?? (pollQuestion || 'Your poll question will appear here')}</strong><div>{(savedPoll ? savedPoll.options.map((option) => option.text) : pollOptions).map((option, index) => <span key={index}>{option || `Option ${index + 1}`}{savedPoll && <> · {savedPoll.options[index]?.votes ?? 0} votes</>}</span>)}</div>{savedPoll && <small>{savedPoll.totalVotes} total votes</small>}</div>
                <div className="overlay-tools">
                  <div><strong>OBS browser overlay</strong><p>Preview the current poll display, then paste its URL into an OBS Browser Source.</p></div>
                  <a href={overlayUrl} target="_blank" rel="noreferrer">Preview overlay</a>
                  <label className="overlay-url-label" htmlFor="poll-overlay-url">Overlay URL</label>
                  <input id="poll-overlay-url" readOnly value={overlayUrl} onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="poll-suggest-button" onClick={() => void copyOverlayUrl()}>Copy overlay URL</button>
                  {overlayFeedback && <span className="overlay-feedback" role="status">{overlayFeedback}</span>}
                </div>
                <div className="beacon-poll-actions">
                  {!savedPoll && <><button className="poll-approve-button" type="button" disabled={pollBusy || !isValidPollInput(pollQuestion, pollOptions)} onClick={() => void savePollDraft(pollQuestion, pollOptions, null, true)}>Start poll</button><button className="poll-suggest-button" type="button" disabled={pollBusy || !isValidPollInput(pollQuestion, pollOptions)} onClick={() => void savePollDraft()}>Save draft</button></>}
                  {savedPoll?.status === 'draft' && <><button className="poll-suggest-button" type="button" disabled={pollBusy || !isValidPollInput(savedPoll.question, savedPoll.options.map((option) => option.text))} onClick={() => void savePollDraft(savedPoll.question, savedPoll.options.map((option) => option.text), savedPoll.id)}>Save edits</button><button className="poll-approve-button" type="button" disabled={pollBusy || !isValidPollInput(savedPoll.question, savedPoll.options.map((option) => option.text))} onClick={() => void changePollState('activate')}>Approve and activate</button></>}
                  {savedPoll?.status === 'active' && <>
                    <button className="poll-approve-button" type="button" disabled={pollBusy} onClick={() => void changePollState('close')}>Close poll</button>
                    {!chatAnnouncementSent && <button className="poll-suggest-button" type="button" disabled={pollBusy || !chatWriteEnabled} onClick={() => void announceSavedPoll()}>Announce poll in chat</button>}
                  </>}
                  {savedPoll?.status === 'closed' && <button className="poll-suggest-button" type="button" onClick={createAnotherPoll}>Create another poll</button>}
                  {pollBusy && <span role="status">Saving…</span>}
                </div>
                {savedPoll?.status === 'draft' && !isValidPollInput(savedPoll.question, savedPoll.options.map((option) => option.text)) && <p className="poll-edit-hint" role="status">Use a 5–140 character question and 2–4 distinct, non-empty options before saving or activating.</p>}
                {!savedPoll && <p className="poll-edit-hint">Review the preview, then Start poll to open voting and announce it in Twitch chat when permitted. Saving a draft is optional.</p>}
                {savedPoll && <p className="poll-approved" role="status">{savedPoll.status === 'active' ? <>Poll is active. Viewers can vote in chat with <code>!vote 1</code> through <code>!vote {savedPoll.options.length}</code>. Each viewer has one current vote and can change their choice. Chat replies are rate limited.</> : savedPoll.status === 'closed' ? 'Poll closed. New votes are ignored.' : 'Draft saved privately for this channel; it has not been published.'}</p>}
              </div>
            </>}
          </div>
        </section>
        <section id="stream-recap" className="panel stream-recap-panel" aria-labelledby="stream-recap-title">
          <div className="panel-heading pulse-heading">
            <div className="panel-title-wrap"><span className="panel-icon recap-icon" aria-hidden="true">▤</span><div><h2 id="stream-recap-title">Stream Recap</h2><p className="panel-subtitle">A saved record of what happened in your stream</p></div></div>
            {recapSessions.length > 0 && <label className="recap-select-label">Session
              <select aria-label="Choose a stream session" value={selectedRecapId} onChange={(event) => { setSelectedRecapId(event.target.value); setRecapNotice('') }}>
                {recapSessions.map((session) => <option key={session.id} value={session.id}>{new Date(session.startedAt).toLocaleString()} · {session.status}</option>)}
              </select>
            </label>}
          </div>
          <div className="recap-content">
            {recapError && <p className="poll-error" role="alert">{recapError}</p>}
            {recapNotice && <p className="recap-notice" role="status">{recapNotice}</p>}
            {sessionPersistenceIssue && <p className="poll-results-stale" role="status">Session storage is having trouble. Chat tracking continues, but saved history and recap counts may be incomplete until storage recovers.</p>}
            {connectionReadiness !== 'connected'
              ? <div className="pulse-empty"><strong>Connect Twitch to track stream sessions</strong><p>Session history is available after Twitch reports a stream start.</p></div>
              : recapLoading
                ? <div className="pulse-empty" role="status">Loading saved session history…</div>
                : !selectedRecap
                  ? <div className="pulse-empty"><strong>No stream sessions recorded yet</strong><p>ChatBeacon starts a session when Twitch reports that your channel is live. A past stream cannot be backfilled.</p></div>
                  : <>
                    <div className="recap-session-line"><span className={`poll-status-badge ${selectedRecap.status === 'completed' ? 'poll-status-closed' : selectedRecap.status === 'active' ? 'poll-status-active' : 'poll-status-interrupted'}`}>{selectedRecap.status}</span><span>Started {new Date(selectedRecap.startedAt).toLocaleString()}</span>{selectedRecap.endedAt && <span>Twitch reported offline at {new Date(selectedRecap.endedAt).toLocaleString()}</span>}{selectedRecap.status === 'interrupted' && <span>Offline time unavailable because Twitch ended while ChatBeacon was offline.</span>}</div>
                    {selectedRecap.captureComplete === false && <p className="poll-results-stale" role="status">This session missed one or more persistence writes. Its saved message history and recap metrics are incomplete.</p>}
                    <div className="recap-stat-grid" aria-label="Session statistics">
                      <article><strong>{selectedRecap.metrics.totalMessages}</strong><span>Messages</span></article>
                      <article><strong>{selectedRecap.metrics.uniqueViewers}</strong><span>Unique viewers</span></article>
                      <article><strong>{selectedRecap.metrics.totalQuestions}</strong><span>Questions detected</span></article>
                      <article><strong>{selectedRecap.metrics.answeredQuestions} / {selectedRecap.metrics.unansweredQuestions}</strong><span>Answered / unanswered</span></article>
                      <article><strong>{selectedRecap.metrics.repeatedQuestions}</strong><span>Repeated questions</span></article>
                      <article><strong>{selectedRecap.metrics.pollCount} · {selectedRecap.metrics.totalVotes}</strong><span>Polls · votes</span></article>
                      <article><strong>{selectedRecap.metrics.questions.filter((question) => question.status === 'follow_up').length}</strong><span>Follow-ups remaining</span></article>
                      <article><strong>{selectedRecap.captureComplete === false ? 'Incomplete' : selectedRecap.captureComplete === true ? 'Complete' : 'Unknown'}</strong><span>Recorded capture</span></article>
                    </div>
                    {selectedRecap.communityPulse && <div className="recap-saved-pulse"><h3>AI interpretation · Community Pulse</h3><p>{selectedRecap.communityPulse.pulse.overallSummary}</p>{selectedRecap.communityPulse.pulse.topics.map((topic) => <p className="recap-list-row" key={topic.title}><span><strong>{topic.title}</strong> · {topic.explanation}</span></p>)}{selectedRecap.communityPulse.pulse.recurringQuestions.map((question) => <p className="recap-list-row" key={question.text}>{question.text}</p>)}</div>}
                    <div className="recap-columns">
                      <div><h3>Questions from this session</h3>{selectedRecap.metrics.questions.length ? selectedRecap.metrics.questions.map((question) => <p className="recap-list-row" key={question.id}><span>{question.text}</span><small>Asked {question.count} {question.count === 1 ? 'time' : 'times'} · {question.status}</small></p>) : <p className="recap-muted">No likely questions were detected.</p>}</div>
                      <div><h3>Poll results</h3>{selectedRecap.metrics.polls.length ? selectedRecap.metrics.polls.map((poll, index) => <article className="recap-poll-result" key={`${selectedRecap.id}-poll-${index}`}><strong>{poll.status === 'closed' ? 'Completed poll' : 'Poll'}</strong><span>{poll.totalVotes} valid votes</span>{poll.options.map((option) => <p key={option.id}>{option.text}<b>{option.votes}</b></p>)}</article>) : <p className="recap-muted">No polls were started during this session.</p>}</div>
                    </div>
                    <div className="recap-ai-area">
                      <div className="recap-ai-heading"><div><h3>Community insights</h3><p>Generated only when you request it, from up to 100 saved messages.</p></div><button className="poll-suggest-button" type="button" disabled={recapBusy || selectedRecap.status === 'active'} onClick={() => void analyzeSelectedSession()}>{recapBusy ? 'Analyzing…' : selectedRecap.analysis ? 'Refresh recap' : 'Generate recap'}</button></div>
                      {selectedRecap.status === 'active' && <p className="recap-muted">Finish the stream before generating its recap.</p>}
                      {selectedRecap.analysis && <div className="recap-analysis">
                        {selectedRecap.analysis.insufficientData ? <p className="recap-muted">{selectedRecap.analysis.insufficientReason}</p> : <>
                          <p className="recap-summary">{selectedRecap.analysis.summary}</p>
                          {[['Main topics', selectedRecap.analysis.topics.map((item) => ({ title: item.title, detail: item.explanation, evidence: item.messageIds }))], ['Frequently repeated questions', selectedRecap.analysis.recurringQuestions.map((item) => ({ title: item.text, detail: `Evidence: ${item.messageIds.join(', ')}`, evidence: item.messageIds }))], ['Notable audience requests', selectedRecap.analysis.audienceRequests.map((item) => ({ title: item.text, detail: `Evidence: ${item.messageIds.join(', ')}`, evidence: item.messageIds }))], ['Worth discussing next stream', selectedRecap.analysis.nextStreamTopics.map((item) => ({ title: item.text, detail: `Evidence: ${item.messageIds.join(', ')}`, evidence: item.messageIds }))], ['Follow-up content ideas', selectedRecap.analysis.contentIdeas.map((item) => ({ title: item.text, detail: `Evidence: ${item.messageIds.join(', ')}`, evidence: item.messageIds }))]].map(([heading, items]) => <div className="recap-insight-group" key={heading as string}><h4>{heading as string}</h4>{(items as Array<{ title: string; detail: string; evidence: string[] }>).length ? (items as Array<{ title: string; detail: string; evidence: string[] }>).map((item) => <p key={item.title}><strong>{item.title}</strong><span>{item.detail}{heading === 'Main topics' ? ` · Evidence: ${item.evidence.join(', ')}` : ''}</span></p>) : <p className="recap-muted">No supported items identified.</p>}</div>)}
                          <small>AI text is based on cited saved messages; counts above come from stored application data. Refreshed {new Date(selectedRecap.analysis.analyzedAt).toLocaleString()} via {selectedRecap.analysis.provider}.</small>
                        </>}
                      </div>}
                      {!selectedRecap.analysis && selectedRecap.status !== 'active' && <p className="recap-muted">Generate a grounded summary of this saved session. No analysis runs while chat is arriving.</p>}
                    </div>
                  </>}
          </div>
        </section>
        <footer className="page-footer"><span>ChatBeacon</span><span>Made for streamers, one question at a time.</span></footer>
      </main>
    </div>
  )
}

export default App
