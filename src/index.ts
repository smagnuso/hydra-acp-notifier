#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { HydraDiscovery } from "./discovery.js";
import { NotifierBridge } from "./bridge.js";
import { DEFAULT_RULE, loadRule, type RuleFunction } from "./rule.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

async function main(): Promise<void> {
  const config = loadConfig();
  setDebug(config.debug);

  let currentRule: RuleFunction = DEFAULT_RULE;
  currentRule = await loadRule(config.ruleConfigPath);

  const bridges = new Map<string, NotifierBridge>();

  const discovery = new HydraDiscovery({
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
    pollIntervalMs: config.hydraPollIntervalMs,
    onAdd: (session) => {
      if (bridges.has(session.sessionId)) {
        return;
      }
      log.info(
        `attaching to ${session.sessionId} agent=${session.agentId ?? "?"} cwd=${session.cwd}`,
      );
      const bridge = new NotifierBridge({
        daemonWsUrl: config.hydraWsUrl,
        token: config.hydraToken,
        meta: {
          sessionId: session.sessionId,
          cwd: session.cwd,
          ...(session.agentId !== undefined
            ? { agentId: session.agentId }
            : {}),
          ...(session.title !== undefined ? { title: session.title } : {}),
        },
        getRule: () => currentRule,
      });
      bridges.set(session.sessionId, bridge);
      bridge.start();
    },
    onRemove: (sessionId) => {
      const bridge = bridges.get(sessionId);
      if (!bridge) {
        return;
      }
      log.info(`detaching from ${sessionId}`);
      bridges.delete(sessionId);
      bridge.stop();
    },
  });
  discovery.start();

  process.on("SIGHUP", () => {
    log.info(`SIGHUP — reloading rule from ${config.ruleConfigPath}`);
    loadRule(config.ruleConfigPath)
      .then((rule) => {
        currentRule = rule;
        for (const bridge of bridges.values()) {
          bridge.refreshRule();
        }
        log.info("rule reload complete");
      })
      .catch((err: unknown) => {
        log.warn(`rule reload failed: ${(err as Error).message}`);
      });
  });

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    discovery.stop();
    for (const bridge of bridges.values()) {
      bridge.stop();
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `hydra-acp-notifier up; daemon=${config.hydraDaemonUrl} rule=${config.ruleConfigPath}`,
  );
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-notifier: ${(err as Error).message}\n`);
  process.exit(1);
});
