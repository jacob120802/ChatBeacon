import assert from 'node:assert/strict'
import test from 'node:test'
import { POLL_OVERLAY_HTML } from '../src/pollOverlay.js'

test('overlay is transparent, safely renders poll text, and refreshes only its local results endpoint', () => {
  assert.match(POLL_OVERLAY_HTML, /background:transparent/u)
  assert.match(POLL_OVERLAY_HTML, /fetch\('\/overlay\/poll'/u)
  assert.match(POLL_OVERLAY_HTML, /question\.textContent=poll\.question/u)
  assert.match(POLL_OVERLAY_HTML, /name\.textContent=/u)
  assert.doesNotMatch(POLL_OVERLAY_HTML, /voterSelections|processedVoteMessageIds|chatterUserId/u)
})

test('overlay marks cached results stale after refresh failure and avoids overlapping polls', () => {
  assert.match(POLL_OVERLAY_HTML, /if\(refreshing\)return/u)
  assert.match(POLL_OVERLAY_HTML, /STALE RESULTS · LAST KNOWN LIVE/u)
  assert.match(POLL_OVERLAY_HTML, /POLL CLOSED · RESULTS MAY BE STALE/u)
  assert.match(POLL_OVERLAY_HTML, /AbortSignal\.timeout\(5000\)/u)
})
