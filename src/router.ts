import type { Logger } from "./util/log.js";
import { dispatchNotification, type Notification } from "./notify.js";
import type { NotifyEvent, RuleFunction } from "./rule.js";

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  agentId?: string;
  title?: string;
}

// Hook used in tests so we can assert on what would have been
// dispatched without spawning notify-send.
export type DispatchFn = (n: Notification) => void;

// Per-session: receive session/update notifications, build a NotifyEvent,
// call the rule fn, dispatch what comes back. The router is async-safe
// (rule fn can be a Promise) but doesn't serialize calls — overlapping
// session/updates produce overlapping notifications, which is fine
// because notify-send is fire-and-forget.
export class EventRouter {
  private rule: RuleFunction;

  constructor(
    rule: RuleFunction,
    private meta: SessionMeta,
    private readonly log: Logger,
    private readonly dispatch: DispatchFn = dispatchNotification,
  ) {
    this.rule = rule;
  }

  setRule(rule: RuleFunction): void {
    this.rule = rule;
  }

  // Discovery can hand back a refreshed sessionMeta (e.g. when the title
  // changes via session_info_update). Caller passes the new meta in;
  // the router stores it for the next event.
  setMeta(meta: SessionMeta): void {
    this.meta = meta;
  }

  async onSessionUpdate(params: Record<string, unknown>): Promise<void> {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (!kind) {
      return;
    }
    await this.runRule({
      sessionId: this.meta.sessionId,
      kind,
      raw: update,
      meta: this.eventMeta(),
    });
  }

  // Fired by PermissionWatcher when a session/request_permission has
  // been outstanding longer than the configured delay. Routes through
  // the user's rule fn just like session/update events.
  async onAwaitingPermission(toolCall: Record<string, unknown>): Promise<void> {
    await this.runRule({
      sessionId: this.meta.sessionId,
      kind: "awaiting_permission",
      raw: toolCall,
      meta: this.eventMeta(),
    });
  }

  private eventMeta(): NotifyEvent["meta"] {
    return {
      ...(this.meta.cwd !== undefined ? { cwd: this.meta.cwd } : {}),
      ...(this.meta.agentId !== undefined ? { agentId: this.meta.agentId } : {}),
      ...(this.meta.title !== undefined ? { title: this.meta.title } : {}),
    };
  }

  private async runRule(event: NotifyEvent): Promise<void> {
    let result: Notification | null | undefined;
    try {
      result = await this.rule(event);
    } catch (err) {
      this.log.warn(
        `rule threw on kind=${event.kind} sessionId=${this.meta.sessionId}: ${(err as Error).message}; skipping notification`,
      );
      return;
    }
    if (!result) {
      return;
    }
    if (!result.title || typeof result.title !== "string") {
      this.log.warn(
        `rule returned a notification with no title for kind=${event.kind}; skipping`,
      );
      return;
    }
    this.log.info(
      `notify kind=${event.kind} session=${this.meta.sessionId.slice(0, 8)} title="${result.title}"`,
    );
    this.dispatch(result);
  }
}
