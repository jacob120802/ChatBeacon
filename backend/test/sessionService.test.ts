import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { calculateSessionMetrics, SessionService } from '../src/sessionService.ts'

test('creates one session per Twitch stream, stores chat across restart, and closes idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-session-'))
  try {
    const path = join(directory, 'sessions.json')
    let id = 0
    const makeId = () => `local-${++id}`
    const service = new SessionService(path, () => new Date('2026-10-30T12:00:00Z'), makeId)
    const first = await service.streamOnline('channel-1', 'stream-1', '2026-10-30T11:45:00Z')
    const duplicate = await service.streamOnline('channel-1', 'stream-1', '2026-10-30T11:45:00Z')
    assert.equal(first.id, duplicate.id)
    await service.saveCommunityPulse('channel-1', first.id, { pulse: { insufficientData: true, insufficientReason: 'Small sample.', topics: [], recurringQuestions: [], overallSummary: 'Not enough data.' }, provider: 'none', analyzedAt: '2026-10-30T12:00:00Z' })
    await service.addMessage({ messageId: 'm1', timestamp: '2026-10-30T12:01:00Z', chatterName: 'Viewer', text: 'When is the next stream?', chatterUserId: 'viewer-1', broadcasterUserId: 'channel-1' })
    await service.setQuestionStatus('channel-1', first.id, `q:channel-1:${first.id}:when is the next stream`, 'answered')

    const restored = new SessionService(path)
    assert.equal((await restored.list('channel-1')).length, 1)
    assert.equal((await restored.getMessages('channel-1', first.id)).length, 1)
    await restored.addMessage({ messageId: 'm1', timestamp: '2026-10-30T12:01:00Z', chatterName: 'Viewer', text: 'When is the next stream?', chatterUserId: 'viewer-1', broadcasterUserId: 'channel-1' })
    assert.equal((await restored.getMessages('channel-1', first.id)).length, 1)
    await restored.streamOffline('channel-1', '2026-10-30T13:00:00Z')
    await restored.streamOffline('channel-1', '2026-10-30T13:00:00Z')
    const completed = await restored.get('channel-1', first.id)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.endedAt, '2026-10-30T13:00:00.000Z')
    assert.equal(completed.questionStatuses[`q:channel-1:${first.id}:when is the next stream`], 'answered')
    assert.equal(completed.communityPulse?.pulse.overallSummary, 'Not enough data.')
    const duplicateLateOnline = await restored.streamOnline('channel-1', 'stream-1', '2026-10-30T11:45:00Z')
    assert.equal(duplicateLateOnline.status, 'completed')
    const second = await restored.streamOnline('channel-1', 'stream-2', '2026-10-30T14:00:00Z')
    await restored.addMessage({ messageId: 'm2', timestamp: '2026-10-30T14:01:00Z', chatterName: 'Other', text: 'What next?', chatterUserId: 'viewer-2', broadcasterUserId: 'channel-1' })
    assert.deepEqual((await restored.getMessages('channel-1', second.id)).map((message) => message.messageId), ['m2'])
    assert.deepEqual((await restored.getMessages('channel-1', first.id)).map((message) => message.messageId), ['m1'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('does not invent an end time after restart and starts a distinct stream separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-session-recovery-'))
  try {
    const path = join(directory, 'sessions.json')
    const service = new SessionService(path)
    const prior = await service.streamOnline('channel-1', 'stream-old', '2026-10-30T11:00:00Z')
    await service.reconcileAfterRestart('channel-1', 'stream-old')
    assert.equal((await service.get('channel-1', prior.id)).status, 'active')
    const restarted = new SessionService(path)
    await restarted.reconcileAfterRestart('channel-1', null)
    const old = (await restarted.list('channel-1'))[0]!
    assert.equal(old.status, 'interrupted')
    assert.equal(old.endedAt, null)
    const next = await restarted.streamOnline('channel-1', 'stream-new', '2026-10-30T14:00:00Z')
    assert.notEqual(next.id, old.id)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reports simulated message-write failures and keeps recap history marked incomplete after recovery', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-session-write-failure-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const service = new SessionService(path)
  const session = await service.streamOnline('channel-1', 'stream-1', '2026-10-30T11:00:00Z')
  assert.equal(service.getPersistenceStatus().state, 'unknown')
  await mkdir(`${path}.${session.id}.messages.jsonl`)

  await assert.rejects(service.addMessage({
    messageId: 'missed-message', timestamp: '2026-10-30T11:01:00Z', chatterName: 'Viewer', text: 'Question?',
    chatterUserId: 'viewer-1', broadcasterUserId: 'channel-1',
  }), /history could not be saved/u)
  assert.deepEqual(service.getPersistenceStatus(), { state: 'degraded', historyMayBeIncomplete: true })
  assert.equal((await service.get('channel-1', session.id)).captureComplete, false)

  await rm(`${path}.${session.id}.messages.jsonl`, { recursive: true })
  await service.addMessage({
    messageId: 'recovered-message', timestamp: '2026-10-30T11:02:00Z', chatterName: 'Viewer', text: 'Question?',
    chatterUserId: 'viewer-1', broadcasterUserId: 'channel-1',
  })
  assert.deepEqual(service.getPersistenceStatus(), { state: 'healthy', historyMayBeIncomplete: true })
  assert.equal((await service.getMessages('channel-1', session.id)).length, 1)
  const restored = new SessionService(path)
  assert.equal((await restored.get('channel-1', session.id)).captureComplete, false)
})

test('calculates question, answer, repeated question and poll totals from stored session data', () => {
  const session = {
    id: 's', streamId: 'twitch-stream', broadcasterId: 'channel', startedAt: '2026-10-30T10:00:00Z', endedAt: null, supersededAt: '2026-10-30T12:00:00Z',
    status: 'interrupted' as const, totalMessages: 4, uniqueViewerIds: ['v1', 'v2'], questionStatuses: { 'live:when is next stream': 'answered' as const }, analysis: null, communityPulse: null,
  }
  const messages = [
    { messageId: 'm1', timestamp: '2026-10-30T10:01:00Z', chatterName: 'A', chatterUserId: 'v1', broadcasterUserId: 'channel', text: 'When is next stream?' },
    { messageId: 'm2', timestamp: '2026-10-30T10:02:00Z', chatterName: 'B', chatterUserId: 'v2', broadcasterUserId: 'channel', text: ' when is next stream?! ' },
    { messageId: 'm3', timestamp: '2026-10-30T10:03:00Z', chatterName: 'B', chatterUserId: 'v2', broadcasterUserId: 'channel', text: 'Great game today' },
    { messageId: 'm4', timestamp: '2026-10-30T10:04:00Z', chatterName: 'A', chatterUserId: 'v1', broadcasterUserId: 'channel', text: 'How do I join?' },
  ]
  const metrics = calculateSessionMetrics(session, messages, [
    { status: 'closed', startedAt: '2026-10-30T11:00:00Z', endedAt: '2026-10-30T11:10:00Z', totalVotes: 5, options: [{ id: 'a', text: 'Yes', votes: 3 }, { id: 'b', text: 'No', votes: 2 }] },
    { status: 'closed', startedAt: '2026-10-30T13:00:00Z', endedAt: '2026-10-30T13:10:00Z', totalVotes: 99, options: [] },
  ])
  assert.equal(metrics.totalMessages, 4)
  assert.equal(metrics.uniqueViewers, 2)
  assert.equal(metrics.totalQuestions, 3)
  assert.equal(metrics.answeredQuestions, 1)
  assert.equal(metrics.unansweredQuestions, 2)
  assert.equal(metrics.repeatedQuestions, 0)
  assert.equal(metrics.pollCount, 1)
  assert.equal(metrics.totalVotes, 5)
})

test('keeps informal questions and filters commands, URL punctuation, emotes and chat-directed questions from recap counts', () => {
  const session = {
    id: 'evaluation', streamId: 'stream', broadcasterId: 'channel', startedAt: '2026-10-30T10:00:00Z', endedAt: null, supersededAt: null,
    status: 'active' as const, totalMessages: 6, uniqueViewerIds: [], questionStatuses: {}, analysis: null, communityPulse: null,
  }
  const messages = [
    { messageId: 'm1', timestamp: '2026-10-30T10:01:00Z', chatterName: 'A', chatterUserId: 'a', broadcasterUserId: 'channel', text: 'Is the boss weak to ice' },
    { messageId: 'm2', timestamp: '2026-10-30T10:02:00Z', chatterName: 'B', chatterUserId: 'b', broadcasterUserId: 'channel', text: 'cuando empieza el torneo' },
    { messageId: 'm3', timestamp: '2026-10-30T10:03:00Z', chatterName: 'C', chatterUserId: 'c', broadcasterUserId: 'channel', text: '!vote 2' },
    { messageId: 'm4', timestamp: '2026-10-30T10:04:00Z', chatterName: 'D', chatterUserId: 'd', broadcasterUserId: 'channel', text: 'https://example.com/?question=yes' },
    { messageId: 'm5', timestamp: '2026-10-30T10:05:00Z', chatterName: 'E', chatterUserId: 'e', broadcasterUserId: 'channel', text: 'POGGERS?' },
    { messageId: 'm6', timestamp: '2026-10-30T10:06:00Z', chatterName: 'F', chatterUserId: 'f', broadcasterUserId: 'channel', text: 'is anyone here from Brazil' },
  ]
  const metrics = calculateSessionMetrics(session, messages, [])
  assert.equal(metrics.totalQuestions, 2)
  assert.deepEqual(metrics.questions.map((question) => question.text), ['Is the boss weak to ice', 'cuando empieza el torneo'])
})

test('scopes question identities and follow-up status to broadcaster and original session across restart', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-question-scope-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const service = new SessionService(path)
  const first = await service.streamOnline('channel-a', 'stream-a1', '2026-10-30T10:00:00Z')
  await service.addMessage({ messageId: 'a1', timestamp: '2026-10-30T10:01:00Z', chatterName: 'Viewer', text: 'When is the next stream?', chatterUserId: 'v1', broadcasterUserId: 'channel-a' })
  const firstQuestions = (await service.get(first.broadcasterId, first.id)).questionStatuses
  const firstQuestionId = Object.keys(firstQuestions)[0] ?? `q:channel-a:${first.id}:when is the next stream`
  await service.setQuestionStatus('channel-a', first.id, firstQuestionId, 'follow_up')
  await service.setQuestionPriority('channel-a', first.id, firstQuestionId, 2)
  await service.streamOffline('channel-a', '2026-10-30T11:00:00Z')
  const second = await service.streamOnline('channel-a', 'stream-a2', '2026-10-30T12:00:00Z')
  await service.addMessage({ messageId: 'a2', timestamp: '2026-10-30T12:01:00Z', chatterName: 'Viewer', text: 'When is the next stream?', chatterUserId: 'v1', broadcasterUserId: 'channel-a' })
  await service.addMessage({ messageId: 'b1', timestamp: '2026-10-30T12:02:00Z', chatterName: 'Other', text: 'When is the next stream?', chatterUserId: 'v2', broadcasterUserId: 'channel-b' })
  const secondQuestionId = `q:channel-a:${second.id}:when is the next stream`
  await assert.rejects(service.setQuestionStatus('channel-b', first.id, firstQuestionId, 'answered'), { statusCode: 404 })
  await assert.rejects(service.setQuestionPriority('channel-b', first.id, firstQuestionId, 1), { statusCode: 404 })
  await assert.rejects(service.setQuestionPriority('channel-a', first.id, firstQuestionId, 3 as 0 | 1 | 2), /priority/u)
  assert.notEqual(firstQuestionId, secondQuestionId)
  const followups = await service.listFollowUps('channel-a')
  assert.equal(followups.length, 1)
  assert.equal(followups[0]?.sessionId, first.id)
  await service.setQuestionStatus('channel-a', first.id, firstQuestionId, 'answered')
  assert.equal((await service.listFollowUps('channel-a')).length, 0)
  const restored = new SessionService(path)
  assert.equal((await restored.get('channel-a', first.id)).questionStatuses[firstQuestionId], 'answered')
  assert.equal((await restored.get('channel-a', first.id)).questionPriorities?.[firstQuestionId], 2)
  assert.equal((await restored.get('channel-a', second.id)).questionStatuses[secondQuestionId], undefined)
})
