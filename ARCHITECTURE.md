# ChatBeacon architecture

ChatBeacon is a local, single-broadcaster prototype. This document describes the implemented path from Twitch chat to a stream recap.

## End-to-end flow

```text
Twitch OAuth
    ↓
Twitch EventSub WebSocket
    ↓
Backend message validation and deduplication
    ↓
Frontend polling → rule-based question detection and grouping
    ↓
Streamer-requested Community Pulse / poll suggestion
    ↓
Poll draft → streamer approval → Twitch chat announcement and votes
    ↓
Poll results API → OBS browser overlay
    ↓
Persisted stream session → deterministic metrics + requested AI recap
```

### Twitch EventSub → Backend

The backend binds to `127.0.0.1:3001`. Twitch OAuth requests `user:read:chat` to receive chat and `user:write:chat` for poll announcements and short vote feedback. OAuth uses a one-use, short-lived state value. The backend validates tokens and the required read scope before subscribing. It restores authorization from a locally saved refresh token and handles EventSub reconnects with bounded retries.

The EventSub handler validates and stores a bounded recent-message list, ignores duplicate message IDs, records messages against the active stream session, and processes poll commands without asking the AI provider. Chat and stream lifecycle subscriptions use the same WebSocket session.

### Backend → Question Tracker

The React dashboard polls `/twitch/messages` and `/twitch/status` about once per second through the Vite development proxy. It detects likely questions with explainable text rules and groups exact or lightly normalized repeats. This is a heuristic; it does not understand every question or combine paraphrases. Live question identities include the broadcaster and stream session. Answered, unanswered, follow-up, and priority values are saved against that session by the backend. Cross-session follow-ups are surfaced in the active dashboard without merging the original question identity. Demo-mode status changes use this browser's local storage.

### Question Tracker → AI Insights

Community Pulse and Stream Recap run only after the streamer requests them. They send bounded message text and message IDs, not viewer IDs or OAuth credentials. The backend validates the provider's structured result and rejects references that were not in the input. Metrics such as messages, viewers, questions, and votes are calculated from stored records, never guessed by the model.

Groq is primary. Cloudflare Workers AI is tried once only for eligible transient Groq failures (for example timeout, rate limit, network failure, or server error). Invalid structured output is reported as an analysis error instead of being accepted as a successful fallback case. Chat ingestion does not wait for AI analysis.

### AI Insights → Poll Management → Twitch Voting

AI suggestions are editable drafts. They are never activated automatically. Poll creation, validation, activation, and closure happen in backend code. Only one poll can be active for the broadcaster at a time.

Voting is deterministic: the backend parses `!vote N`, validates the option and active poll, identifies the chatter by Twitch user ID, and saves one current selection per viewer per poll. A later valid vote replaces the earlier selection. EventSub message IDs prevent a delivered event from being counted twice. Vote counts are derived from the saved selections; public poll results do not include voter IDs. No AI model decides who voted or how votes are counted.

Vote-window policy: the backend uses Twitch's EventSub `metadata.message_timestamp` as the event time, assigning a message to the poll whose activation/closure interval contains that timestamp (both endpoints are inclusive). A delayed event can therefore update the poll that was active when Twitch timestamped it, but cannot be applied to a newer poll. The timestamp is when Twitch sent the EventSub notification; the chat event has no separate viewer-origin timestamp. Exact same-time votes from one viewer keep the first accepted choice because their order cannot be established. These comparisons assume the local system clock used for poll boundaries is reasonably synchronized with Twitch.

### Poll Management → OBS Overlay

OBS loads `http://localhost:3001/poll-overlay` as a Browser Source. The page requests only `/overlay/poll`, a read-only, safe poll result view. The payload includes the question, options, counts, total, and active/closed status; it omits private voter IDs, OAuth tokens, and EventSub session IDs. The overlay is intentionally unauthenticated so OBS can read it. The backend binds to localhost, so this local setup is not a public deployment design; do not expose the backend to a network without adding suitable access controls.

### Stream Recap

Twitch `stream.online` and `stream.offline` notifications define session boundaries. At backend startup, Helix is used to reconcile an already-live stream by its Twitch stream ID and start time. Session metadata is stored in `backend/data/sessions.json`; session chat is stored in companion JSONL files. Poll records, selections, and processed vote-event IDs are stored in `backend/data/polls.json`.

The recap calculates numerical metrics from the saved session messages, question statuses, and associated polls. A recap's narrative insights are generated only on request and saved with that session. If a stream ended while ChatBeacon was offline, the session may be marked interrupted; missed chat cannot be reconstructed, and ChatBeacon does not invent end times. Capture-health state identifies sessions that missed a persistence write; recovery does not erase the affected session's incomplete marker.

`GET /twitch/status` also reports whether session persistence is unverified, healthy, or degraded and whether saved history may be incomplete. A failed message write does not stop live chat ingestion, but the affected recap is marked incomplete; that marker remains after storage recovers.

## Persistence and security boundaries

- `backend/.env` contains local configuration and provider credentials; it must stay out of source control. The committed `.env.example` contains placeholders only.
- The Twitch refresh token is stored in `backend/data/twitch-refresh-token.json` as plaintext. Access tokens and EventSub session IDs stay in backend memory.
- Polls, voter selections, private vote timestamps, processed vote-event IDs, sessions, question statuses, priorities, and session chat are local JSON/JSONL files under ignored `backend/data/`. They survive ordinary backend restarts but are not encrypted, synced, or designed for multiple server instances. There is no automatic retention policy, so session and poll files grow over time.
- The frontend never receives the client secret, access token, refresh token, or voter IDs. Unsafe browser requests are checked against allowed local origins. OAuth state is short-lived and single-use.
- The overlay is deliberately read-only and exposes only poll results. Its unauthenticated localhost route should not be treated as safe for a publicly reachable server.
- AI providers receive only the bounded message fields needed for the requested analysis. Chat stays local when the streamer does not request AI analysis.
- This is a local prototype, not a hardened multi-user production service. The backend's connected Twitch account is the one broadcaster it manages.

## Main local routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Backend process health check |
| `GET /auth/twitch/login` | Begin Twitch OAuth |
| `GET /auth/twitch/callback` | Complete Twitch OAuth |
| `GET /twitch/status` | Safe EventSub, chat-write, and session-persistence health status |
| `GET /twitch/messages` | Recent chat messages |
| `GET /twitch/sessions` | Stream session list and deterministic metrics |
| `GET /twitch/sessions/:id` | Session detail and saved messages |
| `POST /twitch/sessions/:id/analyze` | Generate and save a recap for a completed session |
| `POST /community-pulse` | Analyze a bounded chat batch on request |
| `POST /community-pulse/poll` | Suggest an editable poll from a supported topic |
| `/twitch/polls/...` | Create/edit/activate/announce/close polls and read results |
| `GET /poll-overlay` | OBS overlay page |
| `GET /overlay/poll` | Safe overlay results payload |

The full PowerShell setup and test commands are in [README.md](README.md). A reproducible walkthrough and recording outline are in [DEMO.md](DEMO.md).
