import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidPollInput, parseSavedPoll, parseVoteStatus, updateDraftPollQuestion } from '../src/polling.ts'

test('validates poll question length, option count, distinct text, and blank values', () => {
  assert.equal(isValidPollInput('Which game next?', ['Game A', 'Game B']), true)
  assert.equal(isValidPollInput('No', ['Game A', 'Game B']), false)
  assert.equal(isValidPollInput('Which game next?', ['Game A']), false)
  assert.equal(isValidPollInput('Which game next?', ['Yes', ' yes ']), false)
  assert.equal(isValidPollInput('Which game next?', ['Game A', '']), false)
  assert.equal(isValidPollInput('Which game next?', ['A', 'B', 'C', 'D', 'E']), false)
})

test('accepts empty current poll and rejects malformed poll responses', () => {
  assert.equal(parseSavedPoll(null), null)
  assert.equal(parseSavedPoll({ status: 'active' }), undefined)
  assert.equal(parseSavedPoll({
    id: 'poll-1', question: 'Which game next?', options: [{ id: 'a', text: 'Game A', votes: 0 }, { id: 'b', text: 'Game B', votes: 0 }],
    status: 'draft', createdAt: '2026-10-30T00:00:00Z', startedAt: null, endedAt: null, totalVotes: 0,
  })?.status, 'draft')
})

test('parses safe poll result status and vote feedback without voter identifiers', () => {
  assert.deepEqual(parseVoteStatus({ status: 'active', totalVotes: 3, voteFeedback: {
    kind: 'invalid_option', pollId: 'poll-1', timestamp: '2026-10-30T00:00:00Z',
  }, chatAnnouncement: null }), { status: 'active', totalVotes: 3, voteFeedback: {
    kind: 'invalid_option', pollId: 'poll-1', timestamp: '2026-10-30T00:00:00Z',
  }, chatAnnouncement: null })
  assert.equal(parseVoteStatus({ status: 'active', totalVotes: 3, voteFeedback: { kind: 'poll_closed', pollId: 4 } }), undefined)
})

test('updates a saved draft question while preserving poll state and protects active or closed polls', () => {
  const draft = parseSavedPoll({
    id: 'poll-1', question: 'Which game next?', options: [{ id: 'a', text: 'Game A', votes: 0 }, { id: 'b', text: 'Game B', votes: 0 }],
    status: 'draft', createdAt: '2026-10-30T00:00:00Z', startedAt: null, endedAt: null, totalVotes: 0,
  })!
  const edited = updateDraftPollQuestion(draft, 'Which puzzle should we solve next?')
  assert.equal(edited?.question, 'Which puzzle should we solve next?')
  assert.deepEqual(edited?.options, draft.options)
  assert.equal(updateDraftPollQuestion({ ...draft, status: 'active' }, 'Attempted change')?.question, draft.question)
  assert.equal(updateDraftPollQuestion({ ...draft, status: 'closed' }, 'Attempted change')?.question, draft.question)
})
