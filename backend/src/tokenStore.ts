import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RefreshTokenStorage {
  load(): Promise<string | null>
  save(refreshToken: string): Promise<void>
  clear(): Promise<void>
}

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TOKEN_PATH = resolve(backendDirectory, 'data', 'twitch-refresh-token.json')

type StoredAuthorization = {
  version: 1
  refreshToken: string
}

function isStoredAuthorization(value: unknown): value is StoredAuthorization {
  if (typeof value !== 'object' || value === null) return false
  return 'version' in value && value.version === 1 &&
    'refreshToken' in value && typeof value.refreshToken === 'string' && value.refreshToken.length > 0
}

export class RefreshTokenStore implements RefreshTokenStorage {
  constructor(private readonly filePath = DEFAULT_TOKEN_PATH) {}

  async load(): Promise<string | null> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw new Error('The local Twitch authorization file could not be read.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      throw new Error('The local Twitch authorization file is invalid.')
    }
    if (!isStoredAuthorization(parsed)) throw new Error('The local Twitch authorization file is invalid.')
    return parsed.refreshToken
  }

  async save(refreshToken: string): Promise<void> {
    if (!refreshToken) throw new Error('A refresh token is required for local storage.')

    const temporaryPath = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const record: StoredAuthorization = { version: 1, refreshToken }
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    } catch {
      await unlink(temporaryPath).catch(() => undefined)
      throw new Error('The local Twitch authorization file could not be updated.')
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw new Error('The local Twitch authorization file could not be removed.')
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
