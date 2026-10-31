# ChatBeacon frontend

This folder contains the React + TypeScript dashboard for ChatBeacon. It uses Vite to run the app locally and create production builds. The checked-in `package-lock.json` makes npm the package manager for this project. Twitch and AI credentials are configured only in `backend/.env`; the frontend does not store them.

## Start the app

```powershell
cd C:\Users\HP\Downloads\hackathon\chatbeacon\frontend
npm ci
npm run dev
```

Open the local URL printed in the terminal (usually http://localhost:5173).

## Create a production build

```powershell
npm run build
```

Run frontend tests with:

```powershell
npm test
npm run typecheck:test
```

The test suite combines fast question, poll, and dashboard-model tests with rendered React interactions using Testing Library and jsdom. The rendered tests mock backend responses and do not contact Twitch or an AI provider. `npm run build` type-checks the application source and creates the Vite production bundle.

The dashboard polls the local backend about once per second while mounted. In disconnected mode it displays clearly labeled sample messages; those samples are not sent to the backend or AI providers. In connected mode question state is saved by the backend with the current stream session. Demo question statuses are saved in browser local storage.

For full setup, environment variables, manual Twitch verification, and known limitations, see the root [README](../README.md) and [demo walkthrough](../DEMO.md).
