import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Poll } from './pollService.js'

type StoredPoll = Omit<Poll, 'voterSelections' | 'voterSelectionTimestamps' | 'processedVoteMessageIds'> & Partial<Pick<Poll, 'voterSelections' | 'voterSelectionTimestamps' | 'processedVoteMessageIds'>>

export interface PollRepository {
  load(): Promise<Poll[]>
  save(polls: Poll[]): Promise<void>
}

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_POLL_PATH = resolve(backendDirectory, 'data', 'polls.json')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPollOption(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.text === 'string' &&
    typeof value.votes === 'number' && Number.isInteger(value.votes) && value.votes >= 0
}

export function isStoredPoll(value: unknown): value is StoredPoll {
  if (!isRecord(value)) return false
  const valid = typeof value.id === 'string' && Boolean(value.id) &&
    typeof value.question === 'string' && value.question.trim().length >= 5 && value.question.trim().length <= 140 &&
    Array.isArray(value.options) && value.options.length >= 2 && value.options.length <= 4 && value.options.every(isPollOption) &&
    new Set(value.options.map((option) => option.text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))).size === value.options.length &&
    (value.status === 'draft' || value.status === 'active' || value.status === 'closed') &&
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
    (value.startedAt === null || (typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)))) &&
    (value.endedAt === null || (typeof value.endedAt === 'string' && Number.isFinite(Date.parse(value.endedAt)))) &&
    Number.isInteger(value.totalVotes) && typeof value.totalVotes === 'number' && value.totalVotes >= 0 &&
    value.options.reduce((sum, option) => sum + option.votes, 0) === value.totalVotes &&
    typeof value.broadcasterId === 'string' && Boolean(value.broadcasterId) &&
    (value.voterSelections === undefined || (isRecord(value.voterSelections) &&
      Object.entries(value.voterSelections).every(([userId, optionId]) => Boolean(userId) && typeof optionId === 'string' &&
        Array.isArray(value.options) && value.options.some((option) => isPollOption(option) && option.id === optionId)))) &&
    (value.voterSelectionTimestamps === undefined || (isRecord(value.voterSelectionTimestamps) &&
      Object.entries(value.voterSelectionTimestamps).every(([userId, timestamp]) => Boolean(userId) && typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))))) &&
    (value.processedVoteMessageIds === undefined || (Array.isArray(value.processedVoteMessageIds) &&
      value.processedVoteMessageIds.every((id) => typeof id === 'string' && Boolean(id)) &&
      new Set(value.processedVoteMessageIds).size === value.processedVoteMessageIds.length))
  if (!valid) return false
  const lifecycleValid = (value.status === 'draft' && value.startedAt === null && value.endedAt === null) ||
    (value.status === 'active' && typeof value.startedAt === 'string' && value.endedAt === null) ||
    (value.status === 'closed' && typeof value.startedAt === 'string' && typeof value.endedAt === 'string')
  if (!lifecycleValid) return false
  if (value.voterSelections !== undefined) {
    const voters = value.voterSelections as Record<string, string>
    if (Object.keys(voters).length !== value.totalVotes) return false
    const counts = new Map<string, number>()
    for (const option of value.options as Array<{ id: string; votes: number }>) counts.set(option.id, 0)
    for (const optionId of Object.values(voters)) counts.set(optionId, (counts.get(optionId) ?? 0) + 1)
    if ((value.options as Array<{ id: string; votes: number }>).some((option) => counts.get(option.id) !== option.votes)) return false
  }
  return true
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export class JsonPollStore implements PollRepository {
  constructor(private readonly filePath = DEFAULT_POLL_PATH) {}

  async load(): Promise<Poll[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw new Error('The local poll data could not be read.')
    }

    let parsed: unknown
    try { parsed = JSON.parse(contents) } catch { throw new Error('The local poll data is invalid.') }
    if (!Array.isArray(parsed) || !parsed.every(isStoredPoll)) throw new Error('The local poll data is invalid.')
    const ids = new Set(parsed.map((poll) => poll.id))
    const activeBroadcasters = parsed.filter((poll) => poll.status === 'active').map((poll) => poll.broadcasterId)
    if (ids.size !== parsed.length || new Set(activeBroadcasters).size !== activeBroadcasters.length) throw new Error('The local poll data is invalid.')
    return parsed.map((poll) => ({
      ...structuredClone(poll),
      voterSelections: structuredClone(poll.voterSelections ?? {}),
      voterSelectionTimestamps: structuredClone(poll.voterSelectionTimestamps ?? {}),
      processedVoteMessageIds: [...(poll.processedVoteMessageIds ?? [])],
    }))
  }

  async save(polls: Poll[]): Promise<void> {
    if (!polls.every(isStoredPoll)) throw new Error('Poll data could not be saved.')
    const temporaryPath = `${this.filePath}.${randomUUID()}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(temporaryPath, `${JSON.stringify(polls)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    } catch {
      await unlink(temporaryPath).catch(() => undefined)
      throw new Error('The local poll data could not be updated.')
    }
  }
}
