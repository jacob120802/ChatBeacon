# ChatBeacon backend

The backend is a local Node.js and TypeScript HTTP service. It owns Twitch OAuth and EventSub, AI requests, poll validation and voting, and stream-session persistence. It binds to `127.0.0.1` on port `3001` by default.

## Prerequisites and configuration

- Node.js 22.12 or newer and npm.
- A Twitch Developer application for live chat testing.

From this folder, install the locked dependencies and create a private local configuration file:

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_REDIRECT_URI` in `.env`. The callback must match `http://localhost:3001/auth/twitch/callback` in the Twitch Developer Console. `PORT` and `FRONTEND_URL` are optional and default to `3001` and `http://localhost:5173`.

AI keys are optional. Set `GROQ_API_KEY` for primary analysis. Cloudflare Workers AI credentials are optional and used only for eligible transient Groq failures. See the root [README](../README.md) for all placeholder variable names. Never copy secrets into source files or share `.env`.

## Run locally

In PowerShell, start the backend:

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\backend
npm run dev
```

In a second PowerShell window, start the frontend:

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\frontend
npm run dev
```

Open `http://localhost:5173` and choose **Connect to Twitch** when the dashboard reports that a connection is needed. The default callback redirects back to this dashboard. Set `FRONTEND_URL` in `backend/.env` only if the frontend uses a different local address.

For a production-style local process, run `npm run build` and then `npm start`. This creates `dist/` inside the backend, which is ignored by Git.

## Verification

Run the backend test suite and TypeScript production build from this folder:

```powershell
npm test
npm run build
```

Tests mock Twitch and AI provider APIs; they do not need credentials. OAuth route tests create temporary HTTP servers on loopback. If a restricted execution environment reports `connect EACCES 127.0.0.1:<port>`, run `npm test` in a regular local PowerShell session that permits loopback sockets. Do not remove those tests to work around the restriction.

The `GET /health` route checks only that the HTTP server is running. `GET /twitch/status` provides safe connection and session-persistence status. See [ARCHITECTURE.md](../ARCHITECTURE.md) for API boundaries and the root [README](../README.md) for the manual Twitch and poll walkthrough.

## Local authorization storage

After OAuth authorization, ChatBeacon stores only the Twitch refresh token in `backend/data/twitch-refresh-token.json`. The access token remains in backend memory. At backend startup, ChatBeacon exchanges the saved refresh token for a new access token, validates that token and its chat-reading permission, looks up the Twitch account again, and creates a new EventSub session and subscription. Twitch may rotate the refresh token; ChatBeacon replaces the stored value when that happens.

The token file is ignored by Git and is stored outside the frontend source and build. It is still a plaintext local file, not encrypted or protected by a password. `.gitignore` prevents accidental Git commits but does not protect the file from other software or users who can read this Windows account's project folder. Keep the Windows account and project folder private. To remove saved authorization, stop the backend and delete `backend/data/twitch-refresh-token.json`, then revoke the app under Twitch account connections if needed.

If the token is revoked, expires beyond refresh, or Twitch cannot be reached during startup, the backend stays available but reports a connection issue. Choose **Connect to Twitch** from the dashboard to authorize again.

Polls, voter selections, stream session metadata, question statuses and priorities, and session chat are stored under `backend/data/`. Those local JSON/JSONL files are ignored by Git but are plaintext and have no automatic retention policy. A persistence warning means a session may be incomplete; a later successful write does not make an earlier missed message recoverable.
