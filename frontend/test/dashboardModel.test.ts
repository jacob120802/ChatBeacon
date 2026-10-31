import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOverviewTiles, dashboardNavigation, getPollOverlayUrl } from '../src/dashboardModel.ts'

test('navigation covers each main dashboard area exactly once', () => {
  assert.deepEqual(dashboardNavigation.map(({ id }) => id), [
    'overview', 'chat-tracker', 'community-pulse', 'beacon-pulse', 'stream-recap',
  ])
  assert.equal(new Set(dashboardNavigation.map(({ id }) => id)).size, dashboardNavigation.length)
})

test('overview presents honest empty and disconnected feature states', () => {
  const tiles = buildOverviewTiles({
    live: false,
    pendingQuestions: 0,
    communityAnalysisReady: false,
    pollStatus: 'none',
    pollVotes: 0,
    sessionCount: 0,
    sessionActive: false,
  })

  assert.deepEqual(tiles.map(({ value }) => value), [
    '0', 'Waiting for chat', 'No poll yet', 'No sessions yet',
  ])
  assert.deepEqual(tiles.map(({ href }) => href), [
    '#chat-tracker', '#community-pulse', '#beacon-pulse', '#stream-recap',
  ])
})

test('overview reflects current poll/session data and analysis availability', () => {
  const tiles = buildOverviewTiles({
    live: true,
    pendingQuestions: 3,
    communityAnalysisReady: true,
    pollStatus: 'active',
    pollVotes: 12,
    sessionCount: 2,
    sessionActive: true,
  })

  assert.equal(tiles[0].detail, '3 questions are waiting')
  assert.equal(tiles[1].value, 'Insights ready')
  assert.equal(tiles[2].value, 'Poll active')
  assert.equal(tiles[2].detail, '12 valid votes so far')
  assert.equal(tiles[3].detail, 'A stream session is in progress')
})

test('overlay URL keeps the app host and points at the backend overlay route', () => {
  assert.equal(getPollOverlayUrl('http://localhost:5173/'), 'http://localhost:3001/poll-overlay')
})
