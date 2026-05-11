import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logger } from "./util/log.js";
import type { Notification } from "./notify.js";

const log = logger("rule");

// The shape passed to the user's rule function. A subset of the raw
// session/update notification, augmented with cached session meta from
// discovery so the rule fn doesn't have to reach back into hydra.
export interface NotifyEvent {
  sessionId: string;
  // The ACP update kind, e.g. "turn_complete", "session_info_update",
  // "usage_update", "available_commands_update", "current_mode_update",
  // "current_model_update", etc.
  kind: string;
  // Pass-through of the raw update payload so rules can read fields
  // we don't surface explicitly.
  raw: Record<string, unknown>;
  // Session-level metadata cached by discovery.
  meta: {
    cwd?: string;
    agentId?: string;
    title?: string;
  };
}

// Return null/undefined to skip notification; return a Notification
// object to fire one. Sync or async both supported.
export type RuleFunction = (
  ev: NotifyEvent,
) => Notification | null | undefined | Promise<Notification | null | undefined>;

// Default rule when no config file is present: fire on turn_complete
// with agent + session title in the heading and an agent-shell-attention-
// style friendly stop-reason in the body.
const STOP_REASON_TEXT: Record<string, string> = {
  end_turn: "Finished",
  max_tokens: "Max token limit reached",
  max_turn_requests: "Exceeded request limit",
  refusal: "Refused",
  cancelled: "Cancelled",
};

const SESSION_ID_PREFIX = "hydra_session_";

function shortSessionId(sessionId: string): string {
  const stripped = sessionId.startsWith(SESSION_ID_PREFIX)
    ? sessionId.slice(SESSION_ID_PREFIX.length)
    : sessionId;
  return stripped.slice(0, 8);
}

export const DEFAULT_RULE: RuleFunction = (ev) => {
  if (ev.kind === "awaiting_permission") {
    return defaultAwaitingPermission(ev);
  }
  if (ev.kind !== "turn_complete") {
    return null;
  }
  const cwdBase = ev.meta.cwd
    ? ev.meta.cwd.split("/").filter(Boolean).pop()
    : undefined;
  const heading = ev.meta.title ?? cwdBase;
  const titleParts = [ev.meta.agentId ?? "agent", shortSessionId(ev.sessionId)];
  if (heading) {
    titleParts.push(heading);
  }
  const stopReason =
    typeof ev.raw.stopReason === "string" ? ev.raw.stopReason : undefined;
  const body = stopReason
    ? (STOP_REASON_TEXT[stopReason] ?? `Stop for unknown reason: ${stopReason}`)
    : "Finished";
  const result: Notification = {
    title: `🐉 ${titleParts.join(" · ")}`,
    body,
  };
  return result;
};

function defaultAwaitingPermission(ev: NotifyEvent): Notification {
  const cwdBase = ev.meta.cwd
    ? ev.meta.cwd.split("/").filter(Boolean).pop()
    : undefined;
  const heading = ev.meta.title ?? cwdBase;
  const titleParts = [ev.meta.agentId ?? "agent", shortSessionId(ev.sessionId)];
  if (heading) {
    titleParts.push(heading);
  }
  const tc = ev.raw as {
    title?: unknown;
    name?: unknown;
    kind?: unknown;
  };
  const desc =
    (typeof tc.title === "string" && tc.title) ||
    (typeof tc.name === "string" && tc.name) ||
    (typeof tc.kind === "string" && tc.kind) ||
    "tool call";
  return {
    title: `🔒 ${titleParts.join(" · ")}`,
    body: `Awaiting approval: ${desc}`,
  };
}

let loadCounter = 0;

export async function loadRule(path: string): Promise<RuleFunction> {
  try {
    await stat(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      log.info(
        `no rule config at ${path} — using DEFAULT_RULE (notify on turn_complete; drop a JS file at that path to customize)`,
      );
      return DEFAULT_RULE;
    }
    log.warn(`stat ${path} failed: ${e.message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
  loadCounter += 1;
  const url = `${pathToFileURL(path).href}?v=${Date.now()}-${loadCounter}`;
  try {
    const mod = (await import(url)) as { default?: unknown };
    const fn = mod.default;
    if (typeof fn !== "function") {
      log.warn(`${path} did not export a default function; using DEFAULT_RULE`);
      return DEFAULT_RULE;
    }
    log.info(`loaded notifier rule from ${path}`);
    return fn as RuleFunction;
  } catch (err) {
    log.warn(`import ${path} failed: ${(err as Error).message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
}
