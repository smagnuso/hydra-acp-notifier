import { spawn } from "node:child_process";
import { platform } from "node:os";
import { logger } from "./util/log.js";

const log = logger("notify");

export interface Notification {
  title: string;
  body?: string;
  // "low" | "normal" | "critical" — passed through to notify-send -u.
  // No equivalent on macOS; ignored there.
  urgency?: "low" | "normal" | "critical";
  // Path or freedesktop icon name. Linux only; ignored on macOS.
  icon?: string;
  // Per-notification override for the spawn command (rarely needed —
  // most users set this once via the config function or env vars).
  // Receives the resolved {title, body, urgency, icon} and returns the
  // argv to spawn. Useful for routing to ntfy/pushover/etc.
  command?: { cmd: string; args: string[] };
}

// Default dispatcher chosen by platform. Linux → notify-send, macOS →
// osascript. Fallback (or override): the env var HYDRA_ACP_NOTIFY_CMD
// can name an alternate command (e.g. `terminal-notifier`, or a
// custom script that posts to your phone) — argv built lazily so the
// dispatcher remains synchronous from the caller's POV.
export function dispatchNotification(n: Notification): void {
  if (n.command) {
    spawnDetached(n.command.cmd, n.command.args);
    return;
  }
  const envCmd = process.env.HYDRA_ACP_NOTIFY_CMD;
  if (envCmd) {
    spawnDetached(envCmd, [n.title, n.body ?? ""]);
    return;
  }
  const p = platform();
  if (p === "linux" || p === "freebsd" || p === "openbsd") {
    const args: string[] = [];
    if (n.urgency) {
      args.push("-u", n.urgency);
    }
    if (n.icon) {
      args.push("-i", n.icon);
    }
    args.push("-a", "hydra-acp");
    args.push(n.title);
    if (n.body) {
      args.push(n.body);
    }
    spawnDetached("notify-send", args);
    return;
  }
  if (p === "darwin") {
    // AppleScript escapes: double-quote-in-string is `\\\"` after
    // shell quoting, which becomes `\"` inside the AS literal. Keep
    // the body simple here; users wanting rich macOS notifications
    // should set HYDRA_ACP_NOTIFY_CMD to terminal-notifier.
    const title = escapeApplescript(n.title);
    const body = escapeApplescript(n.body ?? "");
    const script = `display notification "${body}" with title "${title}"`;
    spawnDetached("osascript", ["-e", script]);
    return;
  }
  log.info(`notify(${p}): ${n.title}${n.body ? ` — ${n.body}` : ""}`);
}

function spawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      log.warn(
        `spawn ${cmd} failed: ${err.message} (is it installed and on PATH?)`,
      );
    });
    child.unref();
  } catch (err) {
    log.warn(`spawn ${cmd} threw: ${(err as Error).message}`);
  }
}

function escapeApplescript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
