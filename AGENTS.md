# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-notifier` — headless desktop-notification **extension** for
Hydra. Always-on companion that fires `notify-send` (Linux), `osascript`
(macOS), or a custom command when sessions emit notable events — by default
`turn_complete` and "waiting on approval for too long" — regardless of
which interactive client you have attached.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`.

This is a **client extension**: it connects to the daemon's `/acp`
WebSocket using `HYDRA_ACP_TOKEN`, attaches to every live session with
`historyPolicy: "none"`, and fires notifications on selected events. A
user rule at `~/.hydra-acp/notifier.config.js` (or the
`HYDRA_ACP_NOTIFY_CMD` env var) customizes what triggers and how.

## Layout

- `src/index.ts` — entry point
- `src/discovery.ts`, `src/bridge.ts` — session discovery + per-session WS
- `src/notify.ts` — platform notification dispatch (`notify-send` /
  `osascript` / custom command)
- `src/permission-watcher.ts` — the "waiting on approval for too long"
  timer
- `src/router.ts` — dispatches session events to handlers
- `src/rule.ts`, `src/config.ts` — user config
- `src/acp/`, `src/util/`

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-notifier` on PATH. Registered via
`hydra-acp extension add hydra-acp-notifier`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- Notifications are user-visible; keep default titles and bodies concise
  and non-noisy.
- Platform dispatch is best-effort — a missing `notify-send` shouldn't
  crash the extension. Log and continue.
- User rule can override everything; never assume the default rendering
  path runs.

## Gotchas

- This is an observer-shaped extension. Its attach/detach traffic does
  *not* count as session activity for the daemon's idle timeout — it can't
  keep a quiet session alive. Don't rely on presence to pin sessions.
- Permission-watcher timers must be cancelled when the permission
  resolves (racing clients) — otherwise you fire notifications for prompts
  that have already been answered.
- `HYDRA_ACP_NOTIFY_CMD` receives the payload via env/stdin per the README;
  changing that contract is user-facing.
- **Watcher timers are `.unref()`ed** (`permission-watcher.ts`). Awaiting
  timers cannot keep the process alive; if the notifier is the only
  thing running, it will exit.
- **Both `onResolved` and `shutdown` reply `outcome: "cancelled"`** to
  the daemon (`permission-watcher.ts`). That's cleanup for the
  daemon-side pending JSON-RPC request; skipping it leaks a pending
  request on the daemon.
- **Platform dispatch precedence** (`notify.ts`):
  `command` override > `HYDRA_ACP_NOTIFY_CMD` > platform default.
  Unknown platforms fall through to log-only — no crash, no error.
- **AppleScript escaping is intentionally minimal** (backslash + double
  quote only). The README steers users at rich content toward
  `HYDRA_ACP_NOTIFY_CMD=terminal-notifier`; don't try to make the
  osascript path "safe for arbitrary text" — that's the wrong layer.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
