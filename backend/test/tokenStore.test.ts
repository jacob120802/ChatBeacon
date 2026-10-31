import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RefreshTokenStore } from '../src/tokenStore.ts'

test('refresh token storage saves, replaces, loads, and removes its dedicated file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-token-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'twitch-refresh-token.json')
  const store = new RefreshTokenStore(filePath)

  assert.equal(await store.load(), null)
  await store.save('fake-refresh-token-one')
  assert.equal(await store.load(), 'fake-refresh-token-one')
  await store.save('fake-refresh-token-two')
  assert.equal(await store.load(), 'fake-refresh-token-two')
  assert.deepEqual(await readdir(directory), ['twitch-refresh-token.json'])

  const savedFile = await readFile(filePath, 'utf8')
  assert.doesNotMatch(savedFile, /fake-access-token|client-secret/)
  await store.clear()
  assert.equal(await store.load(), null)
})

test('invalid token storage fails with a generic message', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'chatbeacon-token-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'twitch-refresh-token.json')
  await writeFile(filePath, '{not valid JSON with private token content}')

  await assert.rejects(new RefreshTokenStore(filePath).load(), {
    message: 'The local Twitch authorization file is invalid.',
  })
})
