# hydra-acp-notifier

Headless desktop-notification extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Always-on companion that fires `notify-send` / `osascript` (or a custom command) when sessions emit notable events — turn complete and "waiting on approval for too long" by default — regardless of which interactive client you have attached.

Runs as a daemon-managed process so notifications keep firing even when no interactive client is open.

## Install

From npm (recommended once published):

```sh
npm install -g @hydra-acp/notifier
```

This drops a `hydra-acp-notifier` binary on your PATH.

Or from source:

```sh
git clone git@github.com:smagnuso/hydra-acp-notifier.git ~/dev/hydra-acp-notifier
cd ~/dev/hydra-acp-notifier
npm install
npm run build
```

Register the extension with hydra. If installed via npm:

```sh
hydra-acp extensions add hydra-acp-notifier --command hydra-acp-notifier
```

Or pointed at a local build:

```sh
hydra-acp extensions add hydra-acp-notifier \
  --command node \
  --args ~/dev/hydra-acp-notifier/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "extensions": {
    "hydra-acp-notifier": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-notifier/dist/index.js"],
      "enabled": true
    }
  }
}
```

On `hydra-acp daemon start`, hydra spawns hydra-acp-notifier with these env
vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`.
Stdout/stderr land in `~/.hydra-acp/extensions/hydra-acp-notifier.log`. Lifecycle
is managed with `hydra-acp extensions start|stop|restart hydra-acp-notifier` and
`hydra-acp extensions logs hydra-acp-notifier -f` to tail.

## Default behavior (no config)

Fires `notify-send` on two events for every session:

**1. `turn_complete`** — the agent finished a turn.
- **Title**: `🐉 <agentId> · <short-session-id> · <session title or cwd-basename>`
  - `<short-session-id>` is the first 8 chars of the session id after the `hydra_session_` prefix is stripped — handy for telling apart multiple sessions on the same project. The trailing component is omitted if neither a session title nor a cwd is known.
- **Body**: a friendly rendering of the stop reason (borrowed from [`agent-shell-attention`](https://github.com/ultronozm/agent-shell-attention.el)):

  | stopReason          | body                       |
  |---------------------|----------------------------|
  | `end_turn`          | `Finished`                 |
  | `max_tokens`        | `Max token limit reached`  |
  | `max_turn_requests` | `Exceeded request limit`   |
  | `refusal`           | `Refused`                  |
  | `cancelled`         | `Cancelled`                |
  | missing             | `Finished`                 |
  | anything else       | `Stop for unknown reason: <reason>` |

**2. `awaiting_permission`** — a `session/request_permission` has been outstanding for `HYDRA_ACP_NOTIFIER_AWAITING_PERMISSION_MS` (default `5000`). Synthesized by the notifier when no client has answered within the delay.
- **Title**: `🔒 <agentId> · <short-session-id> · <heading>` (same fallback chain).
- **Body**: `Awaiting approval: <toolCall.title or .name or .kind, falls back to "tool call">`.
- **Urgency**: `critical` (notify-send keeps the bubble sticky on Linux).

If the matching `session/permission_resolved` arrives before the delay elapses, no notification fires.

On macOS, `osascript` is used instead. The default works without any config file — drop one in to customize.

## Configure

`~/.hydra-acp/notifier.config.js` (override path via `HYDRA_ACP_NOTIFIER_CONFIG`). Default-exports a function that decides per session/update event:

```js
// ~/.hydra-acp/notifier.config.js
export default function notify(ev) {
  // ev.kind: "turn_complete" | "awaiting_permission" | "usage_update" |
  //          "session_info_update" | ...
  // ev.sessionId, ev.meta.cwd, ev.meta.agentId, ev.meta.title
  // ev.raw: for session/update kinds, the update payload;
  //         for "awaiting_permission", the toolCall object.

  if (ev.kind === "awaiting_permission") {
    // ev.raw.title / .name / .kind describe the pending tool call.
    return {
      title: `🔒 ${ev.meta.agentId ?? "agent"} needs you`,
      body: `Awaiting: ${ev.raw.title ?? ev.raw.name ?? "tool call"}`,
      urgency: "critical",
    };
  }

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

After editing `notifier.config.js`:

```sh
hydra-acp extensions restart hydra-acp-notifier
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
| `HYDRA_ACP_NOTIFIER_AWAITING_PERMISSION_MS` | `5000` | Delay before firing the `awaiting_permission` notification |
| `HYDRA_ACP_NOTIFY_CMD` | *(platform-default)* | Override the spawn command globally |
| `DEBUG` | `false` | Verbose logging |

## How it works

- Attaches to every live session (one WS per session, polled every 2s).
- Listens for `session/update` notifications and dispatches per the rule.
- Receives `session/request_permission` requests but never picks an option — instead, starts a timer of `HYDRA_ACP_NOTIFIER_AWAITING_PERMISSION_MS`. If the matching `session/permission_resolved` arrives first, the notifier replies `cancelled` (harmless — the daemon already settled the agent's call via the real responder). If the timer fires first, the notifier synthesizes an `awaiting_permission` event through the same rule pipeline.

The notifier never picks an `optionId` on a permission request — it's a read-only watcher even when it holds a request open. The daemon excludes the originator from `turn_complete` broadcasts (see `hydra-acp/src/core/session.ts` `broadcastTurnComplete`). Since the notifier never sends prompts, it's always a non-originator and always sees every `turn_complete`.

