import { AcpAttach } from "./acp/attach.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  PermissionRequestParams,
} from "./acp/protocol.js";
import { PermissionWatcher } from "./permission-watcher.js";
import { EventRouter, type SessionMeta } from "./router.js";
import type { RuleFunction } from "./rule.js";
import { logger } from "./util/log.js";

const log = logger("bridge");

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
  meta: SessionMeta;
  getRule: () => RuleFunction;
  awaitingPermissionMs: number;
}

// One bridge per discovered session. Listens to session/update for
// turn_complete (etc.) and to session/request_permission for the
// awaiting-approval timer. SIGHUP-driven rule reloads propagate via
// the getRule thunk.
export class NotifierBridge {
  private readonly attach: AcpAttach;
  private readonly router: EventRouter;
  private readonly watcher: PermissionWatcher;
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.attach = new AcpAttach({
      sessionId: opts.meta.sessionId,
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
    });
    this.router = new EventRouter(opts.getRule(), opts.meta, log);
    this.watcher = new PermissionWatcher(
      opts.awaitingPermissionMs,
      (toolCall) => void this.router.onAwaitingPermission(toolCall),
      log,
    );
  }

  start(): void {
    this.attach.on("notification", (n) => this.onNotification(n));
    this.attach.on("request", (r) => this.onRequest(r));
    this.attach.on("close", () => {
      this.watcher.shutdown();
    });
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
    this.watcher.shutdown();
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
    const update = (params.update ?? {}) as {
      sessionUpdate?: unknown;
      toolCallId?: unknown;
    };
    if (update.sessionUpdate === "permission_resolved") {
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      if (toolCallId) {
        this.watcher.onResolved({ toolCallId });
      }
      return;
    }
    void this.router.onSessionUpdate(params);
  }

  private onRequest(r: JsonRpcRequest): void {
    if (r.method === "session/request_permission") {
      const params = (r.params ?? {}) as PermissionRequestParams;
      this.watcher.onRequest(params, (result) => this.attach.reply(r.id, result));
      return;
    }
    this.attach.replyError(r.id, -32601, `method not implemented: ${r.method}`);
  }
}
