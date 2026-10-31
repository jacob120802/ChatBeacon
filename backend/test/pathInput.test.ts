import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePathSegment } from '../src/pathInput.ts'

test('decodes valid route identifiers and returns null for malformed encoding', () => {
  assert.equal(decodePathSegment('poll-123'), 'poll-123')
  assert.equal(decodePathSegment('session%20id'), 'session id')
  assert.equal(decodePathSegment('%E0%A4%A'), null)
  assert.equal(decodePathSegment('%'), null)
})
