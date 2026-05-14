import type { Logger } from "./util/log.js";
import type { PermissionRequestParams } from "./acp/protocol.js";

export type RespondFn = (result: unknown) => void;
export type OnAwaitingFn = (
  toolCall: PermissionRequestParams["toolCall"],
) => void;

interface Pending {
  toolCallId: string;
  respond: RespondFn;
  timer: NodeJS.Timeout;
}

// Tracks `session/request_permission` requests we've received but not
// yet seen resolved. On request, start a timer. If the timer fires
// before the matching session/update permission_resolved arrives,
// invoke `onAwaiting` so the router can dispatch a "still waiting"
// notification.
// On resolved (or shutdown), respond to the original request with
// `cancelled` to clean up the daemon-side pending promise — harmless
// because the daemon already settled the agent's call via whoever won
// the race.
export class PermissionWatcher {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly delayMs: number,
    private readonly onAwaiting: OnAwaitingFn,
    private readonly log: Logger,
  ) {}

  onRequest(params: PermissionRequestParams, respond: RespondFn): void {
    const toolCallId = params.toolCall?.toolCallId;
    if (!toolCallId) {
      respond({ outcome: { outcome: "cancelled" } });
      return;
    }
    const existing = this.pending.get(toolCallId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.log.info(
        `awaiting_permission fired toolCallId=${toolCallId} after ${this.delayMs}ms`,
      );
      try {
        this.onAwaiting(params.toolCall);
      } catch (err) {
        this.log.warn(
          `onAwaiting callback threw: ${(err as Error).message}`,
        );
      }
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(toolCallId, { toolCallId, respond, timer });
  }

  onResolved(params: { toolCallId: string }): void {
    const { toolCallId } = params;
    if (!toolCallId) {
      return;
    }
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      return;
    }
    this.pending.delete(toolCallId);
    clearTimeout(entry.timer);
    entry.respond({ outcome: { outcome: "cancelled" } });
  }

  shutdown(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      try {
        entry.respond({ outcome: { outcome: "cancelled" } });
      } catch {
        // connection is already gone, nothing to do
      }
    }
    this.pending.clear();
  }
}
