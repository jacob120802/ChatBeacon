import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedMutationOrigin } from '../src/requestSecurity.ts'

test('allows configured local dashboard and local backend origins', () => {
  assert.equal(isAllowedMutationOrigin('http://localhost:5173'), true)
  assert.equal(isAllowedMutationOrigin('http://127.0.0.1:3001'), true)
  assert.equal(isAllowedMutationOrigin('http://localhost:5180', 'http://localhost:5180/'), true)
})

test('rejects cross-site, null, malformed, and unconfigured local browser origins', () => {
  assert.equal(isAllowedMutationOrigin('https://attacker.example'), false)
  assert.equal(isAllowedMutationOrigin('null'), false)
  assert.equal(isAllowedMutationOrigin('not a URL'), false)
  assert.equal(isAllowedMutationOrigin('http://localhost:5180'), false)
})

test('continues to allow local non-browser clients that do not send Origin', () => {
  assert.equal(isAllowedMutationOrigin(undefined), true)
})
