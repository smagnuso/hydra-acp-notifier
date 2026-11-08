import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { win32 } from "node:path";
import { logger } from "./util/log.js";

const log = logger("notify");

export interface Notification {
  title: string;
  body?: string;
  // "low" | "normal" | "critical" — passed through to notify-send -u.
  // No equivalent on macOS or Windows; ignored there.
  urgency?: "low" | "normal" | "critical";
  // Path or freedesktop icon name. Linux only; ignored on macOS and Windows.
  icon?: string;
  // Per-notification override for the spawn command (rarely needed —
  // most users set this once via the config function or env vars).
  // Receives the resolved {title, body, urgency, icon} and returns the
  // argv to spawn. Useful for routing to ntfy/pushover/etc.
  command?: { cmd: string; args: string[] };
}

// What to run for one notification. `env`, when present, replaces the
// child's environment; it is how the Windows toast receives its text.
export interface SpawnPlan {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnOptions,
) => ChildProcess;

export interface DispatchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
}

// Text limits for a toast. The shell shows far less than this; the cap keeps
// the environment block (32 KB total on Windows) from ever being the failure.
const TOAST_TITLE_MAX = 200;
const TOAST_BODY_MAX = 1000;

// Constant on purpose. The title and body arrive through the environment
// and are read as $env:..., never interpolated into this text: they are
// agent- and rule-authored, and building them into a script would make every
// notification a command-injection path. CreateTextNode does the XML
// escaping, so a `<` in a title is shown rather than parsed.
//
// The app id is Windows PowerShell's own. A toast is only shown for an id the
// shell knows, and registering a hydra one needs a Start Menu shortcut, which
// an npm package should not be creating. The cost is that the toast is
// attributed to "Windows PowerShell".
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$text = $xml.GetElementsByTagName('text')
[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:HYDRA_ACP_TOAST_TITLE))
[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:HYDRA_ACP_TOAST_BODY))
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  // Windows PowerShell 5.1 specifically: the toast API is a WinRT projection
  // that PowerShell 7 does not load. By full path so a PATH without System32
  // (a service, a stripped environment) still finds it.
  const root = env["SystemRoot"] ?? env["windir"];
  return root
    ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

export function planToast(n: Notification, env: NodeJS.ProcessEnv): SpawnPlan {
  return {
    cmd: windowsPowerShell(env),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(TOAST_SCRIPT, "utf16le").toString("base64"),
    ],
    env: {
      ...env,
      HYDRA_ACP_TOAST_TITLE: n.title.slice(0, TOAST_TITLE_MAX),
      HYDRA_ACP_TOAST_BODY: (n.body ?? "").slice(0, TOAST_BODY_MAX),
    },
  };
}

// Decide what to run, without running it. Null means there is nothing to
// spawn on this platform and the caller should just log.
export function planNotification(
  n: Notification,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): SpawnPlan | null {
  if (n.command) {
    return { cmd: n.command.cmd, args: n.command.args };
  }
  const envCmd = env["HYDRA_ACP_NOTIFY_CMD"];
  if (envCmd) {
    return { cmd: envCmd, args: [n.title, n.body ?? ""] };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
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
    return { cmd: "notify-send", args };
  }
  if (platform === "darwin") {
    // AppleScript escapes: double-quote-in-string is `\\\"` after
    // shell quoting, which becomes `\"` inside the AS literal. Keep
    // the body simple here; users wanting rich macOS notifications
    // should set HYDRA_ACP_NOTIFY_CMD to terminal-notifier.
    const title = escapeApplescript(n.title);
    const body = escapeApplescript(n.body ?? "");
    const script = `display notification "${body}" with title "${title}"`;
    return { cmd: "osascript", args: ["-e", script] };
  }
  if (platform === "win32") {
    return planToast(n, env);
  }
  return null;
}

// Default dispatcher chosen by platform. Linux → notify-send, macOS →
// osascript, Windows → a toast through Windows PowerShell. Fallback (or
// override): the env var HYDRA_ACP_NOTIFY_CMD can name an alternate command
// (e.g. `terminal-notifier`, or a custom script that posts to your phone) —
// argv built lazily so the dispatcher remains synchronous from the caller's
// POV.
export function dispatchNotification(
  n: Notification,
  deps: DispatchDeps = {},
): void {
  const platform = deps.platform ?? osPlatform();
  const plan = planNotification(n, deps.env ?? process.env, platform);
  if (!plan) {
    log.info(`notify(${platform}): ${n.title}${n.body ? ` — ${n.body}` : ""}`);
    return;
  }
  spawnDetached(plan, platform, deps.spawn ?? spawn);
}

function spawnDetached(
  plan: SpawnPlan,
  platform: NodeJS.Platform,
  spawnFn: SpawnFn,
): void {
  const windows = platform === "win32";
  try {
    const child = spawnFn(plan.cmd, plan.args, {
      // stderr is kept on Windows so a toast that fails (a missing WinRT
      // projection or a policy block; Focus Assist only hides it) leaves a
      // reason in the log rather than nothing.
      stdio: windows ? ["ignore", "ignore", "pipe"] : "ignore",
      // detached makes Windows create the child with DETACHED_PROCESS, which
      // also defeats windowsHide, so a console window flashes for every
      // notification. Nothing here needs the child to outlive this process.
      detached: !windows,
      windowsHide: true,
      ...(plan.env ? { env: plan.env } : {}),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (err) => {
      log.warn(
        `spawn ${plan.cmd} failed: ${err.message} (is it installed and on PATH?)`,
      );
    });
    if (windows) {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          log.warn(`${plan.cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
        }
      });
    }
    child.unref();
  } catch (err) {
    log.warn(`spawn ${plan.cmd} threw: ${(err as Error).message}`);
  }
}

function escapeApplescript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
