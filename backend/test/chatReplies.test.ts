import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatReplyLimiter, formatPollAnnouncement, formatVoteReply } from '../src/chatReplies.js'
import type { Poll, VoteReceipt } from '../src/pollService.js'

const poll: Poll = {
  id: 'poll-1', question: 'Which game next?', options: [
    { id: 'option-1', text: 'Game A', votes: 0 }, { id: 'option-2', text: 'Game B', votes: 0 },
  ], status: 'active', createdAt: '2026-10-30T00:00:00Z', startedAt: '2026-10-30T00:00:01Z', endedAt: null,
  totalVotes: 0, broadcasterId: 'channel-1', voterSelections: {}, processedVoteMessageIds: [],
}

test('announces the question, options, and command in one concise chat message', () => {
  const announcement = formatPollAnnouncement(poll)
  assert.match(announcement, /Which game next/u)
  assert.match(announcement, /1\) Game A/u)
  assert.match(announcement, /2\) Game B/u)
  assert.match(announcement, /!vote 1-2/u)
  assert.ok(Array.from(announcement).length <= 490)
})

test('formats accepted, changed, invalid, and closed vote replies', () => {
  const receipt = (result: VoteReceipt['result'], option = poll.options[0]!): VoteReceipt => ({
    result, poll, selectedOption: result === 'accepted' || result === 'updated' || result === 'unchanged' ? option : null,
  })
  assert.equal(formatVoteReply(receipt('accepted')), 'Vote counted for Game A.')
  assert.equal(formatVoteReply(receipt('updated', poll.options[1]!)), 'Your vote is now Game B.')
  assert.equal(formatVoteReply(receipt('invalid_option')), 'Vote not counted. Use !vote 1-2.')
  assert.equal(formatVoteReply({ result: 'poll_closed', poll, selectedOption: null }), 'This poll is closed; new votes are not counted.')
  assert.equal(formatVoteReply(receipt('duplicate')), null)
})

test('throttles channel replies and each viewer without growing its tracking map unbounded', () => {
  const limiter = new ChatReplyLimiter(2_000, 10_000, 2)
  assert.equal(limiter.reserve('viewer-1', 1_000), true)
  assert.equal(limiter.reserve('viewer-2', 2_000), false)
  assert.equal(limiter.reserve('viewer-2', 3_000), true)
  assert.equal(limiter.reserve('viewer-2', 13_001), true)
  assert.equal(limiter.reserve('viewer-3', 16_000), true)
  assert.equal(limiter.reserve('viewer-1', 18_001), true)
})
