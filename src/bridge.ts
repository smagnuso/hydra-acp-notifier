import { AcpAttach } from "./acp/attach.js";
import type { JsonRpcNotification } from "./acp/protocol.js";
import { EventRouter, type SessionMeta } from "./router.js";
import type { RuleFunction } from "./rule.js";
import { logger } from "./util/log.js";

const log = logger("bridge");

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
  meta: SessionMeta;
  getRule: () => RuleFunction;
}

// One bridge per discovered session. Observer-role attach, listens to
// session/update notifications, dispatches them to EventRouter.
// SIGHUP-driven rule reloads propagate via the getRule thunk.
export class NotifierBridge {
  private readonly attach: AcpAttach;
  private readonly router: EventRouter;
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.attach = new AcpAttach({
      sessionId: opts.meta.sessionId,
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
    });
    this.router = new EventRouter(opts.getRule(), opts.meta, log);
  }

  start(): void {
    this.attach.on("notification", (n) => this.onNotification(n));
    this.attach.on("error", (err) => {
      log.warn(`attach error ${this.opts.meta.sessionId}: ${err.message}`);
    });
    this.attach.start();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.attach.stop();
  }

  refreshRule(): void {
    this.router.setRule(this.opts.getRule());
  }

  updateMeta(meta: SessionMeta): void {
    this.router.setMeta(meta);
  }

  private onNotification(n: JsonRpcNotification): void {
    if (n.method !== "session/update") {
      return;
    }
    const params = (n.params ?? {}) as Record<string, unknown>;
    void this.router.onSessionUpdate(params);
  }
}
