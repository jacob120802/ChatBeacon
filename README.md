# ChatBeacon

### Your Twitch chat, organized around the questions that matter.

ChatBeacon helps Twitch streamers keep up with viewer questions, recurring topics, and requests while they are live. It is designed for solo streamers and small creator teams who cannot read every message while playing or presenting.

During a busy stream, useful questions can disappear in a fast-moving chat. ChatBeacon collects recent messages, groups likely repeated questions, and gives the streamer tools to answer questions, understand discussion themes, and run a chat poll.

Its value is in connecting those tasks in one local dashboard: rule-based question tracking, optional evidence-linked AI summaries, deterministic Twitch chat voting, an OBS overlay, and a recap based on saved session records.

## Core features

- Live Twitch chat ingestion through EventSub, with duplicate message protection and connection status.
- Explainable, session-scoped question detection and repeat grouping, with answered, unanswered, follow-up, reopen, and manual priority controls.
- Persisted follow-ups across streams, capture-health feedback, and a recap that distinguishes recorded metrics from AI interpretation.
- On-demand Community Pulse summaries and poll suggestions, grounded in bounded message batches.
- Streamer-created poll drafts, approval, activation, chat announcements, viewer votes, and live results.
- A browser-source overlay for OBS and a post-stream recap with data-derived metrics.
- A clearly labeled demo mode when Twitch is not connected.

This is a hackathon prototype. It has not been validated with external users.

## What works today

- React, TypeScript, and Vite dashboard with demo and Twitch-message modes.
- Twitch OAuth authorization using `user:read:chat` and `user:write:chat` scopes.
- Backend startup restoration using a locally saved refresh token.
- Twitch EventSub WebSocket subscription to the authorized account's own chat.
- Recent message validation, bounded in-memory storage, and duplicate-ID protection.
- Frontend polling about once per second, question grouping, status filters, and answer/reopen controls.
- Session-scoped question statuses and priorities saved by the backend for live Twitch streams; demo statuses are saved in this browser's local storage.
- Cross-session follow-up questions surfaced in the current question queue.
- Session capture health and incomplete-history warnings shown in status and recap views.
- Optional, on-demand Community Pulse summaries using Groq, with Cloudflare Workers AI as a transient-failure fallback.
- Beacon Pulse poll drafts with manual creation or topic-based AI suggestions, editing, preview, activation, and closure.
- Persisted stream sessions with deterministic metrics and on-demand AI recaps.

Question detection is a heuristic. It recognizes question marks and some common question structures. Repeats are grouped only when capitalization, whitespace, and trailing punctuation normalize to the same text; possible schedule paraphrases are suggested conservatively but remain separate questions. Questions, statuses, and priorities are scoped to their saved stream session.

## Architecture overview

The short data flow is Twitch EventSub → backend → question tracker → on-demand AI insights → poll management → Twitch chat voting → OBS overlay → Stream Recap. See [ARCHITECTURE.md](ARCHITECTURE.md) for component responsibilities, data storage, and security boundaries.

The backend binds to `127.0.0.1` on port `3001`. Vite normally runs on port `5173` and proxies `/twitch`, `/community-pulse`, and `/overlay` requests to the backend. OAuth starts directly at `http://localhost:3001/auth/twitch/login` and returns to the dashboard.

## Requirements

- Node.js 22.12 or newer (the project has been checked with Node.js 24.22.1).
- npm (the repository has `package-lock.json` files; use npm rather than pnpm).
- A Twitch Developer application for live Twitch testing. Demo mode does not need Twitch credentials.

## First-time setup (Windows PowerShell)

From the project folder, install each app's locked dependencies:

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\backend
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Open `backend/.env` in a local editor and enter your own Twitch Client ID and Client Secret. Do not paste these values into chat, commit them, or put them in frontend files. The example contains these variable names:

```text
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://localhost:3001/auth/twitch/callback
PORT=3001
FRONTEND_URL=http://localhost:5173
```

`FRONTEND_URL` is optional and is used as the local OAuth return address. Keep the Twitch Developer Console callback exactly set to `http://localhost:3001/auth/twitch/callback`.

Community Pulse is optional; the app starts normally without AI credentials. To enable it, add a Groq API key to `backend/.env`. Groq is the primary provider. Cloudflare Workers AI credentials are optional and are used once only when Groq has a timeout, rate limit, network failure, or server error. The example model IDs are `openai/gpt-oss-20b` for Groq and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for Cloudflare Workers AI. Model access and billing depend on your provider account, and availability can change; check the [Groq model catalog](https://console.groq.com/docs/models) and [Cloudflare Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) before using a model. Never put these keys in the frontend or share the `.env` file.

Available optional variables (copy from `backend/.env.example`):

```text
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

After connecting Twitch and receiving messages, choose **Analyze chat** in Community Pulse. The backend sends up to 50 recent message texts with their message IDs to the configured provider only after that click; chatter names and account details are not sent. No sample/demo messages are sent. The endpoint caps batches at 100 messages and 20,000 message characters, limits each provider request to 12 seconds, and caps provider responses. Analysis does not run on each chat message and does not block EventSub ingestion. Provider output is validated, including that cited message IDs came from the supplied batch. For each recurring topic you can request a poll draft and edit it before saving. Beacon Pulse lets you create drafts manually, preview them, activate one poll per channel, and close it. Polls are saved in `backend/data/polls.json`, ignored by Git, and survive backend restarts.

Viewers can vote in the connected channel chat by sending `!vote 1`, `!vote 2`, and so on while a poll is active. Each Twitch user ID has one current selection per poll; a later valid vote changes their selection. Vote selections and EventSub message IDs are saved with the poll to make reconnect deliveries idempotent. Public results omit voter IDs. On activation ChatBeacon announces the question and choices. It sends brief, rate-limited replies to votes and invalid/closed commands. The OAuth flow requests `user:read:chat` and `user:write:chat`; read-only connections can receive and count votes but cannot send chat messages until reauthorized with the write scope.

### Test voting locally

1. Connect Twitch and confirm chat is connected.
2. Create a poll draft in Beacon Pulse, then review and activate it. Activation sends the poll question and numbered choices to the channel chat when chat writing is authorized.
3. From a viewer account, send `!vote 1` (or another displayed option number). Send a different valid number to change that viewer's vote.
4. Confirm the dashboard and overlay counts update, then close the poll and verify new votes are rejected.

The broadcaster can use their own account for a basic test; a second viewer account is better for checking that separate viewers count as separate votes. Do not flood chat with test commands.

The OBS browser-source overlay is available at `http://localhost:3001/poll-overlay` while the backend is running. In OBS, add a **Browser Source**, paste that URL, and size it to fit the scene. It shows an active poll and counts, or the last closed poll, and is served only by the backend bound to the local machine. Polls are local to ChatBeacon rather than Twitch-native polls. See [DEMO.md](DEMO.md) for a full walk-through and recording plan.

Poll API routes through the Vite proxy: `GET /twitch/polls/current`, `GET /twitch/polls/active`, `GET /twitch/polls/results`, `GET /twitch/polls/status`, `POST /twitch/polls`, `GET /twitch/polls/:id`, `PATCH /twitch/polls/:id`, `POST /twitch/polls/:id/activate`, `POST /twitch/polls/:id/announce`, and `POST /twitch/polls/:id/close`. The local OBS overlay uses `GET /overlay/poll`. Streamer routes require an authorized Twitch session.

In a second PowerShell window, install and start the frontend:

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\frontend
npm ci
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`. Start the backend in the first window:

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\backend
npm run dev
```

The frontend works in clearly labeled demo mode before Twitch is connected. Choose **Connect to Twitch** and approve the requested chat-reading and chat-writing permissions to test your own channel. Chat reading can work without chat writing, but poll announcements and chat replies need the write permission.

## Checks and production builds

Run these from the corresponding folder:

```powershell
# Backend
npm test
npm run build

# Frontend
npm test
npm run typecheck:test
npm run build
```

Tests use synthetic messages and mocked Twitch and AI provider requests; they do not need credentials or call paid inference. The frontend suite includes rendered React interactions using jsdom and Testing Library, as well as question, poll, and navigation model tests. The backend suite covers OAuth route behavior, token storage, EventSub recovery, Community Pulse validation and fallback behavior, session and poll persistence, request security, and chat voting. OAuth route tests bind temporary HTTP servers to loopback; environments that prohibit local sockets may report `EACCES` for those tests even though they make no request to Twitch. Run the commands in a normal local PowerShell session if that restriction applies.

## Manual demo checklist

1. Start backend and frontend in separate PowerShell windows.
2. Visit `/health` at `http://localhost:3001/health`; it should return `{"status":"ok"}`.
3. Open the dashboard and confirm it says Demo mode while Twitch is disconnected.
4. Connect your own Twitch account and approve `user:read:chat` and `user:write:chat` if you want poll announcements and chat replies.
5. Check that `/twitch/status` reports a connected EventSub subscription. The endpoint returns safe status only, not tokens or session IDs.
6. Send chat messages in your own channel and check that they appear in the dashboard and `http://localhost:3001/twitch/messages`.
7. Repeat a question with different letter case or punctuation; it should join the same group. A differently worded question should remain separate.
8. Mark a question answered, set it for follow-up, and reopen it. Try the priority control, then reload to confirm live question status and priority remain saved for the stream.
9. Stop the backend and confirm the dashboard shows a connection issue without removing the last successfully displayed messages. Restart it and check whether the subscription restores.

## Troubleshooting

- **Backend cannot start:** check whether port `3001` is already in use. Set another `PORT` only if you also update the Twitch callback and frontend's direct OAuth link/proxy configuration.
- **Login says configuration is missing:** confirm the local `backend/.env` exists and the three Twitch variables are set. Never share that file.
- **Twitch returns to the dashboard with an error:** verify the callback URL matches exactly, then reconnect and approve the chat-reading permission.
- **Backend is healthy but chat is not live:** `/health` only checks that the HTTP server runs. Check `http://localhost:3001/twitch/status` for both `state: connected` and `subscription: enabled`.
- **Messages are stale:** the backend may have lost its EventSub connection or authorization. Restarting the backend attempts restoration; if authorization is revoked, connect again.
- **OAuth tests fail with `connect EACCES 127.0.0.1`:** the test host is blocking temporary loopback listeners. Run `npm test` in `backend` from a normal local PowerShell session; these tests mock Twitch and do not need credentials.
- **Frontend does not reach the backend:** keep both local servers running and check that Vite uses port `5173` and the backend uses `3001`.

## Data, privacy, and known limitations

- `backend/.env` is ignored by Git. The refresh token is saved in `backend/data/twitch-refresh-token.json`, also ignored by Git.
- Polls, private per-poll voter selections, and processed vote-event IDs are saved in `backend/data/polls.json`, also ignored by Git. This local JSON store is suitable for this single-process prototype; it is not encrypted, multi-instance, or account-syncing storage. There is no retention policy, so the poll file grows with polls and votes. Public results omit voter IDs.
- The refresh-token file is plain text. Git ignore rules prevent normal commits but do not encrypt the file or protect it from other software running as your Windows user. Delete it only after stopping the backend to remove local authorization, and revoke the app from your Twitch account if needed.
- Access tokens and EventSub session IDs remain in backend memory. Messages received during tracked streams are also appended to local session history under `backend/data/`.
- Stream Recap uses Twitch's `stream.online` and `stream.offline` EventSub notifications. At startup, it checks Helix Get Streams to recover an already-live stream by Twitch stream ID and `started_at`. These subscriptions require no additional Twitch scope. The end time is Twitch's EventSub notification timestamp (when Twitch reported offline), since the offline event itself does not include an end-time field. If Twitch reports a stream ended while ChatBeacon was offline, its session is marked interrupted and no end timestamp is fabricated. A stream that began before ChatBeacon first connected cannot be backfilled with old chat.
- Session metadata is saved in `backend/data/sessions.json`; each session's chat is stored in a companion JSONL file. Live question statuses, priorities, and follow-up state are saved with their broadcaster and stream session. Demo statuses use this browser's local storage. Polls are associated by their activation time within a session boundary. These local files are not encrypted or synchronized between machines.
- Session recap routes are `GET /twitch/sessions`, `GET /twitch/sessions/:id`, `POST /twitch/sessions/:id/questions/status`, and `POST /twitch/sessions/:id/analyze`. Analysis sends up to 100 saved message IDs and texts to the configured provider only when requested; viewer IDs and account credentials are not sent. Analysis is stored with the session and can be refreshed on demand.
- Detection can miss questions and can classify some statements as questions. It is not AI or guaranteed language understanding.
- Twitch keepalive timeouts, `session_reconnect`, and unexpected closures have bounded recovery. A lost session opens a fresh socket and recreates the subscription with exponential delays (1, 2, 4, 8, and 16 seconds); after five failed retries the backend reports an error and stops retrying. Authorization errors stop retries so the dashboard can ask you to connect again. The retry budget resets after a connection remains healthy for one minute. EventSub does not replay chat messages missed during a disconnect.
- Local JSON and JSONL persistence is intended for one streamer and one backend process. Long-running deployments or many streams will grow local history; this prototype does not provide retention controls, encryption at rest, or concurrent multi-process storage.
- No external-user validation has been performed. The Twitch end-to-end flow depends on your own registered application and account and was not re-run as part of the automated audit.
- Community Pulse and Stream Recap are model-generated interpretations and can omit or misinterpret context. Review the cited source messages before acting on them. Messages leave the local backend only when you explicitly request analysis. The API key stays on the backend. Fallback happens only for transient Groq failures, at most once; invalid model output or message references outside the submitted batch are rejected.

## How Codex was used

Codex was used as a coding partner during the hackathon to scaffold the React and TypeScript apps, implement the dashboard and Twitch/AI/poll/session flows in small steps, add focused tests, investigate failures, and review the release. The project owner supplied local credentials, approved Twitch account actions, and should review AI summaries and approve every poll before it is activated. No credentials belong in documentation, frontend code, or source control.
