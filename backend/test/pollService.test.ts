import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseVoteCommand, PollError, PollService, PollStorageError, toPublicPoll, type Poll } from '../src/pollService.js'
import { JsonPollStore, type PollRepository } from '../src/pollStore.js'

const valid = { question: 'Which game next?', options: ['Stardew Valley', 'Hades'] }

class MemoryPollStore implements PollRepository {
  private polls: Poll[] = []
  async load(): Promise<Poll[]> { return structuredClone(this.polls) }
  async save(polls: Poll[]): Promise<void> { this.polls = structuredClone(polls) }
}

test('creates a validated draft and keeps it after a backend restart', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-polls-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const repository = new JsonPollStore(join(directory, 'polls.json'))
  const first = new PollService(repository, () => new Date('2026-10-30T10:00:00Z'), () => 'poll-1')
  const created = await first.createDraft('channel-1', valid)
  assert.equal(created.status, 'draft')
  assert.equal(created.options.length, 2)
  assert.equal(created.totalVotes, 0)
  assert.equal(created.broadcasterId, 'channel-1')
  const restored = await new PollService(repository).getCurrent('channel-1')
  assert.equal(restored?.id, 'poll-1')
})

test('updates an existing persisted poll file repeatedly', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-polls-existing-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'polls.json')
  await writeFile(file, '[]\n', 'utf8')
  const service = new PollService(new JsonPollStore(file))
  const draft = await service.createDraft('channel-1', valid)
  const edited = await service.editDraft('channel-1', draft.id, { question: 'Which game should we play?', options: ['Game A', 'Game B'] })
  const active = await service.activate('channel-1', edited.id)
  const closed = await service.close('channel-1', active.id)
  assert.equal(closed.status, 'closed')
  const restored = await new PollService(new JsonPollStore(file)).getById('channel-1', draft.id)
  assert.equal(restored.status, 'closed')
  assert.equal(restored.question, 'Which game should we play?')
})

test('loads older saved polls with empty vote state without discarding them', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-polls-migration-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'polls.json')
  await writeFile(file, JSON.stringify([{
    id: 'legacy-poll', question: 'Which game next?',
    options: [{ id: 'option-1', text: 'Game A', votes: 0 }, { id: 'option-2', text: 'Game B', votes: 0 }],
    status: 'draft', createdAt: '2026-10-30T10:00:00Z', startedAt: null, endedAt: null, totalVotes: 0, broadcasterId: 'channel-1',
  }]), 'utf8')
  const loaded = await new JsonPollStore(file).load()
  assert.equal(loaded[0]?.id, 'legacy-poll')
  assert.deepEqual(loaded[0]?.voterSelections, {})
  assert.deepEqual(loaded[0]?.voterSelectionTimestamps, {})
  assert.deepEqual(loaded[0]?.processedVoteMessageIds, [])
})

test('rejects invalid question and option counts or duplicates', async () => {
  const service = new PollService(new MemoryPollStore())
  await assert.rejects(service.createDraft('channel-1', { ...valid, question: '  ' }), PollError)
  await assert.rejects(service.createDraft('channel-1', { ...valid, options: ['Only one'] }), PollError)
  await assert.rejects(service.createDraft('channel-1', { ...valid, options: ['Yes', ' yes '] }), /different/u)
})

test('edits a draft, activates only one poll, rejects duplicate transitions, then closes it', async () => {
  let sequence = 0
  const service = new PollService(new MemoryPollStore(), () => new Date(`2026-10-30T10:00:0${sequence++}Z`), () => `poll-${sequence++}`)
  const first = await service.createDraft('channel-1', valid)
  const edited = await service.editDraft('channel-1', first.id, { question: 'Which adventure next?', options: ['Game A', 'Game B', 'Game C'] })
  assert.equal(edited.question, 'Which adventure next?')
  const active = await service.activate('channel-1', first.id)
  assert.equal(active.status, 'active')
  await assert.rejects(service.activate('channel-1', first.id), /Only a draft/u)
  await assert.rejects(service.editDraft('channel-1', first.id, valid), /Only a draft/u)
  const second = await service.createDraft('channel-1', valid)
  await assert.rejects(service.activate('channel-1', second.id), /Close the active poll/u)
  const closed = await service.close('channel-1', first.id)
  assert.equal(closed.status, 'closed')
  assert.ok(closed.endedAt)
  assert.equal((await service.activate('channel-1', second.id)).status, 'active')
})

test('does not expose polls across broadcaster accounts', async () => {
  const service = new PollService(new MemoryPollStore())
  const poll = await service.createDraft('channel-1', valid)
  await assert.rejects(service.getById('channel-2', poll.id), { statusCode: 404 })
})

test('returns a safe actionable error when local storage is unavailable', async () => {
  const brokenRepository: PollRepository = {
    async load() { throw new Error('private filesystem details') },
    async save() { throw new Error('private filesystem details') },
  }
  const service = new PollService(brokenRepository)
  await assert.rejects(service.createDraft('channel-1', valid), (error) => {
    assert.ok(error instanceof PollStorageError)
    assert.equal(error.statusCode, 503)
    assert.match(error.message, /backend\/data/u)
    assert.doesNotMatch(error.message, /private filesystem details/u)
    return true
  })
})

test('parses vote commands case-insensitively with whitespace and rejects malformed commands', () => {
  assert.deepEqual(parseVoteCommand('  !VOTE   2  '), { kind: 'vote', optionNumber: 2 })
  assert.deepEqual(parseVoteCommand('!vote 9'), { kind: 'vote', optionNumber: 9 })
  assert.deepEqual(parseVoteCommand('!vote nope'), { kind: 'invalid' })
  assert.equal(parseVoteCommand('hello !vote 1'), null)
})

test('records the first vote, updates repeat votes, and deduplicates EventSub message IDs', async () => {
  const service = new PollService(new MemoryPollStore())
  const draft = await service.createDraft('channel-1', valid)
  const active = await service.activate('channel-1', draft.id)
  const timestamp = (offset: number) => new Date(Date.parse(active.startedAt!) + offset).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'event-1', 1, timestamp(10))).result, 'accepted')
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'event-1', 2, timestamp(10))).result, 'duplicate')
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'event-2', 2, timestamp(20))).result, 'updated')
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'event-2', 1, timestamp(20))).result, 'duplicate')
  const result = await service.getById('channel-1', draft.id)
  assert.equal(result.totalVotes, 1)
  assert.deepEqual(result.options.map((option) => option.votes), [0, 1])
})

test('ignores invalid options, wrong broadcaster, and votes without an active poll', async () => {
  let tick = 0
  const service = new PollService(new MemoryPollStore(), () => new Date(Date.parse('2026-10-30T10:00:00Z') + tick++ * 1_000))
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'before', 1, '2026-10-30T10:00:00Z')).result, 'no_active_poll')
  const draft = await service.createDraft('channel-1', valid)
  const active = await service.activate('channel-1', draft.id)
  const voteAt = new Date(Date.parse(active.startedAt!) + 10).toISOString()
  assert.equal((await service.recordVote('channel-2', 'viewer-1', 'wrong-channel', 1, voteAt)).result, 'no_active_poll')
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'bad-option', 3, voteAt)).result, 'invalid_option')
  assert.equal((await service.getById('channel-1', draft.id)).totalVotes, 0)
  assert.equal((await service.getStatus('channel-1')).voteFeedback?.kind, 'invalid_option')
  await service.close('channel-1', draft.id)
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'after-close', 1, '2026-10-30T10:00:04Z')).result, 'poll_closed')
  assert.equal((await service.getStatus('channel-1')).voteFeedback?.kind, 'poll_closed')
})

test('serializes concurrent votes and preserves private voter choices after restart', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-voting-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const repository = new JsonPollStore(join(directory, 'polls.json'))
  const service = new PollService(repository)
  const draft = await service.createDraft('channel-1', valid)
  const active = await service.activate('channel-1', draft.id)
  const eventTime = active.startedAt!
  const outcomes = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    service.recordVote('channel-1', `viewer-${index}`, `event-${index}`, index % 2 + 1, eventTime)))
  assert.equal(outcomes.filter((outcome) => outcome.result === 'accepted').length, 40)
  const repeatedViewerVotes = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    service.recordVote('channel-1', 'viewer-100', `repeat-${index}`, index % 2 + 1, eventTime)))
  assert.equal(repeatedViewerVotes.filter((outcome) => outcome.result === 'accepted').length, 1)
  assert.equal(repeatedViewerVotes.filter((outcome) => outcome.result === 'out_of_order').length, 9)
  const restoredService = new PollService(repository)
  assert.equal((await restoredService.recordVote('channel-1', 'viewer-0', 'event-0', 2, eventTime)).result, 'duplicate')
  const restored = await restoredService.getById('channel-1', draft.id)
  assert.equal(restored.totalVotes, 41)
  assert.equal(restored.options.reduce((total, option) => total + option.votes, 0), 41)
  assert.equal(Object.keys(restored.voterSelections).length, 41)
  const publicPoll = toPublicPoll(restored)
  assert.equal('voterSelections' in publicPoll, false)
  assert.equal('voterSelectionTimestamps' in publicPoll, false)
  assert.equal('processedVoteMessageIds' in publicPoll, false)
  assert.equal('broadcasterId' in publicPoll, false)
})

test('uses EventSub times to isolate poll windows and ignores reordered votes', async () => {
  let tick = 0
  const service = new PollService(new MemoryPollStore(), () => new Date(Date.parse('2026-10-30T10:00:00Z') + tick++ * 10_000))
  const firstDraft = await service.createDraft('channel-1', valid)
  const first = await service.activate('channel-1', firstDraft.id)
  const firstVoteAt = new Date(Date.parse(first.startedAt!) + 1_000).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'newer', 2, firstVoteAt)).result, 'accepted')
  const olderVoteAt = new Date(Date.parse(first.startedAt!) + 500).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-1', 'older-delivery', 1, olderVoteAt)).result, 'out_of_order')
  assert.deepEqual((await service.getById('channel-1', first.id)).options.map((option) => option.votes), [0, 1])
  const firstClosed = await service.close('channel-1', first.id)
  const justAfterClose = firstClosed.endedAt!.replace(/\.\d+Z$/u, '.000000001Z')
  assert.equal((await service.recordVote('channel-1', 'viewer-9', 'after-close-sub-ms', 1, justAfterClose)).result, 'poll_closed')

  const nextDraft = await service.createDraft('channel-1', valid)
  const next = await service.activate('channel-1', nextDraft.id)
  const delayedOldVote = new Date(Date.parse(first.startedAt!) + 2_000).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-2', 'delayed-old-poll', 1, delayedOldVote)).result, 'accepted')
  assert.equal((await service.getById('channel-1', first.id)).totalVotes, 2)
  assert.equal((await service.getById('channel-1', next.id)).totalVotes, 0)

  const beforeNextActivation = new Date(Date.parse(firstClosed.endedAt!) + 1).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-3', 'between-polls', 1, beforeNextActivation)).result, 'outside_poll_window')
  await service.close('channel-1', next.id)
  const afterNextClosure = new Date(Date.parse((await service.getById('channel-1', next.id)).endedAt!) + 1).toISOString()
  assert.equal((await service.recordVote('channel-1', 'viewer-4', 'after-next-close', 1, afterNextClosure)).result, 'poll_closed')
})
