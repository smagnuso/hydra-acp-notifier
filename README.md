# hydra-acp-notifier

Headless desktop-notification extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Always-on companion that fires `notify-send` / `osascript` (or a custom command) when sessions emit notable events — turn complete, by default — regardless of which interactive client you have attached.

Runs as a daemon-managed process so notifications keep firing even when no interactive client is open.

## Install

```sh
git clone git@github.com:smagnuso/hydra-acp-notifier.git ~/dev/hydra-acp-notifier
cd ~/dev/hydra-acp-notifier
npm install
npm run build
npm link
```

Register in `~/.hydra-acp/config.json`:

```json
{
  "extensions": {
    "hydra-acp-notifier": {}
  }
}
```

Then `hydra-acp daemon restart`. Logs land in `~/.hydra-acp/extensions/hydra-acp-notifier.log`.

## Default behavior (no config)

Fires `notify-send` on `turn_complete` for every session, with:
- **Title**: `🐉 <agentId> · <cwd-basename>`
- **Body**: `turn complete (<stopReason>)`

On macOS, `osascript` is used instead. The default works without any config file — drop one in to customize.

## Configure

`~/.hydra-acp/notifier.config.js` (override path via `HYDRA_ACP_NOTIFIER_CONFIG`). Default-exports a function that decides per session/update event:

```js
// ~/.hydra-acp/notifier.config.js
export default function notify(ev) {
  // ev.kind: "turn_complete" | "usage_update" | "session_info_update" | ...
  // ev.sessionId, ev.meta.cwd, ev.meta.agentId, ev.meta.title
  // ev.raw: the raw session/update.update payload

  if (ev.kind !== "turn_complete") {
    return null; // skip
  }

  // Suppress quiet auto-titled sessions, only notify named ones:
  // if (!ev.meta.title || ev.meta.title.startsWith("!")) return null;

  const stop = typeof ev.raw.stopReason === "string" ? ev.raw.stopReason : null;
  return {
    title: `${ev.meta.agentId ?? "agent"} done`,
    body: stop ? `(${stop}) ${ev.meta.cwd ?? ""}` : (ev.meta.cwd ?? ""),
    urgency: "normal", // notify-send -u; ignored on macOS
    // icon: "dialog-information",    // Linux only
    // command: { cmd: "terminal-notifier", args: ["-message", "..."] },
  };
}
```

### Event shape

```ts
interface NotifyEvent {
  sessionId: string;
  kind: string;                    // session/update kind
  raw: Record<string, unknown>;    // raw update payload
  meta: {
    cwd?: string;
    agentId?: string;
    title?: string;
  };
}
```

### Notification shape

```ts
interface Notification {
  title: string;
  body?: string;
  urgency?: "low" | "normal" | "critical"; // Linux only (notify-send -u)
  icon?: string;                            // Linux only (notify-send -i)
  // Per-notification override of the spawn command. Useful for routing
  // a particular event to ntfy/Pushover/etc.
  command?: { cmd: string; args: string[] };
}
```

Return `null` / `undefined` to skip. Throws are caught + logged + treated as skip.

### Reload

```sh
kill -HUP $(cat ~/.hydra-acp/extensions/hydra-acp-notifier.pid)
```

## Custom dispatcher (route everything to ntfy / Pushover / phone)

Set `HYDRA_ACP_NOTIFY_CMD=/path/to/script` to override the spawn for *all* notifications globally. The script receives the title and body as `$1` and `$2`. Or set per-notification via `command` in the rule's return value.

Example: `~/bin/ntfy-relay`:

```sh
#!/bin/sh
curl -d "$2" -H "Title: $1" -H "Priority: default" ntfy.sh/your-topic
```

## Environment

| Env var | Default | Purpose |
|---|---|---|
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:8765` | Daemon HTTP endpoint (injected by hydra) |
| `HYDRA_ACP_TOKEN` | *(required)* | Daemon auth token (injected by hydra) |
| `HYDRA_ACP_WS_URL` | derived | Override WS endpoint |
| `HYDRA_ACP_NOTIFIER_CONFIG` | `~/.hydra-acp/notifier.config.js` | Rule module path |
| `HYDRA_ACP_NOTIFIER_POLL_MS` | `2000` | Session-discovery poll interval |
| `HYDRA_ACP_NOTIFY_CMD` | *(platform-default)* | Override the spawn command globally |
| `DEBUG` | `false` | Verbose logging |

## How it works

- Attaches as `observer` to every live session (one WS per session, polled every 2s).
- Listens for `session/update` notifications.
- For each, calls your rule function and dispatches whatever it returns.

Observer role keeps the notifier out of `attached_clients` controller counts and the permission-request fan-out — it's read-only.

The daemon explicitly excludes the originator from `turn_complete` broadcasts (see `hydra-acp/src/core/session.ts` `broadcastTurnComplete`). Since the notifier never sends prompts, it's always a non-originator and always sees every `turn_complete`.

## Why this beats per-client notifications

Any per-client notifier only fires while that client is attached. Centralizing in the daemon means one set of rules fires regardless of which (or how many) clients are connected, and survives client restarts.

## Tests

```sh
npm test
```

Covers EventRouter dispatch / null / throw / async / meta / setRule / setMeta / DEFAULT_RULE behavior, plus rule loader file-missing / no-default-export paths.
