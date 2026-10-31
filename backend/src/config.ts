import { config as loadDotenv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

loadDotenv({ path: resolve(backendDirectory, '.env') })

function readRequired(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      `Missing required configuration: ${name}. Copy backend/.env.example to backend/.env and set the value.`,
    )
  }

  return value
}

export function getTwitchConfig() {
  return {
    clientId: readRequired('TWITCH_CLIENT_ID'),
    clientSecret: readRequired('TWITCH_CLIENT_SECRET'),
    redirectUri: readRequired('TWITCH_REDIRECT_URI'),
  }
}
