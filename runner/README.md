# KWH Payments Runner UI

React operator dashboard for the Playwright suite. Live feed of running tests, responsive desktop / mobile layouts, and a global stop button that terminates the run immediately.

## Stack

- Vite + React + TypeScript
- Tailwind CSS (responsive utility classes)
- Express + Server-Sent Events (SSE) backend
- Custom Playwright reporter that emits `__UI__:{json}` lines on stdout

## Install

```bash
# from the repo root
npm run runner:install
```

## Run

```bash
# from the repo root — starts Vite (port 5173) + Express (port 3001) together
npm run runner:dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/events` to the Express server, so no CORS wrangling.

## What the UI shows

- **Header** — pulsing status pill (idle / starting / running / stopped / completed).
- **Status panel** — total / passed / failed / skipped counters + elapsed time + progress %.
- **Live feed** — one row per test; running rows pulse, finished rows show duration and error snippet.
- **Server log** (desktop only) — Playwright stdout + warnings.
- **Stop button** — sticky at the bottom on mobile, in the sidebar on desktop. Requires one confirmation click to prevent misfires. Sends `POST /api/stop` → server sends `SIGTERM` to the Playwright child, then `SIGKILL` after 3s if it hasn't exited.

## Responsive behavior

`useIsMobile()` swaps components based on viewport width + user-agent. Mobile view is a single stacked column with a sticky bottom action bar; desktop view is a sidebar + main-content grid. Both use Tailwind breakpoints inside components for finer-grained tuning.

## Files

```
runner/
  server/index.ts         Express + SSE, spawns and kills Playwright
  src/
    App.tsx               Device-detect and render one of two views
    types.ts              UiEvent, TestRecord, RunSummary
    hooks/
      useIsMobile.ts      Viewport + UA-based detection
      useTestStream.ts    Connects to /events, reduces events into state
    views/
      DesktopView.tsx     Sidebar + main feed
      MobileView.tsx      Stacked view with sticky Stop button
    components/
      Header.tsx
      StatusPanel.tsx
      StopButton.tsx
      TestList.tsx
      TestRow.tsx
```

The custom reporter lives at `tests/reporters/ui-reporter.ts` and is enabled automatically when the server sets `UI_REPORTER=1` before spawning Playwright. Regular `npm test` runs are unaffected.
