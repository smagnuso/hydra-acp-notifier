import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  hydraPollIntervalMs: number;
  // Absolute path to the user's notifier-config JS module
  // (~/.hydra-acp/notifier.config.js by default). When missing, the
  // notifier falls back to a sensible default (fire on turn_complete
  // with a tidy title/body); see `defaultDecide` in router.ts.
  ruleConfigPath: string;
  // How long an unanswered session/request_permission has to sit before
  // we fire an "Awaiting approval" notification.
  awaitingPermissionMs: number;
  debug: boolean;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

export function loadConfig(): Config {
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:8765";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra extension, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const ruleConfigPath =
    process.env.HYDRA_ACP_NOTIFIER_CONFIG ??
    resolve(homedir(), ".hydra-acp", "notifier.config.js");

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    hydraPollIntervalMs: intEnv("HYDRA_ACP_NOTIFIER_POLL_MS", 2000),
    ruleConfigPath,
    awaitingPermissionMs: intEnv(
      "HYDRA_ACP_NOTIFIER_AWAITING_PERMISSION_MS",
      5000,
    ),
    debug: boolEnv("DEBUG", false),
  };
}
