import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventRouter } from "../src/router.js";
import type { Notification } from "../src/notify.js";
import type { Logger } from "../src/util/log.js";
import { DEFAULT_RULE } from "../src/rule.js";

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function captureDispatch(): {
  fn: (n: Notification) => void;
  calls: Notification[];
} {
  const calls: Notification[] = [];
  return {
    fn: (n) => {
      calls.push(n);
    },
    calls,
  };
}

test("dispatches notification when rule returns one", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => ({ title: "hi", body: "there" }),
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { title: "hi", body: "there" });
});

test("skips when rule returns null", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => null,
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 0);
});

test("supports async rule fn", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    async () => {
      await new Promise<void>((r) => setImmediate(r));
      return { title: "async!" };
    },
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "async!");
});

test("swallows rule throws without dispatching", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => {
      throw new Error("boom");
    },
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 0);
});

test("ignores notifications with no kind", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => ({ title: "should not fire" }),
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: {},
  });
  assert.equal(calls.length, 0);
});

test("skips notification with empty title", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => ({ title: "" }),
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 0);
});

test("rule sees session meta on the event", async () => {
  const { fn, calls } = captureDispatch();
  let seenMeta: Record<string, string | undefined> | undefined;
  const router = new EventRouter(
    (ev) => {
      seenMeta = ev.meta;
      return { title: "ok" };
    },
    {
      sessionId: "hydra_session_x",
      cwd: "/work/repo",
      agentId: "claude-acp",
      title: "Investigate bug",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    sessionId: "hydra_session_x",
    update: { sessionUpdate: "turn_complete" },
  });
  assert.deepEqual(seenMeta, {
    cwd: "/work/repo",
    agentId: "claude-acp",
    title: "Investigate bug",
  });
  assert.equal(calls.length, 1);
});

test("setRule replaces the rule for subsequent events", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    () => null,
    { sessionId: "hydra_session_x" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 0);
  router.setRule(() => ({ title: "new" }));
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "new");
});

test("session_info_update rotates title for subsequent notifications", async () => {
  const { fn, calls } = captureDispatch();
  const seen: Array<string | undefined> = [];
  const router = new EventRouter(
    (ev) => {
      seen.push(ev.meta.title);
      return ev.kind === "turn_complete" ? { title: ev.meta.title ?? "?" } : null;
    },
    {
      sessionId: "hydra_session_x",
      agentId: "claude-acp",
      title: "Initial",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "session_info_update", title: "Renamed" },
  });
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.deepEqual(seen, ["Renamed", "Renamed"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "Renamed");
});

test("session_info_update rotates agentId from _meta on /hydra agent", async () => {
  const { fn, calls } = captureDispatch();
  const seen: Array<string | undefined> = [];
  const router = new EventRouter(
    (ev) => {
      seen.push(ev.meta.agentId);
      return ev.kind === "turn_complete" ? { title: ev.meta.agentId ?? "?" } : null;
    },
    {
      sessionId: "hydra_session_x",
      agentId: "claude-acp",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: {
      sessionUpdate: "session_info_update",
      _meta: { "hydra-acp": { synthetic: true, agentId: "codex-acp" } },
    },
  });
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.deepEqual(seen, ["codex-acp", "codex-acp"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "codex-acp");
});

test("session_info_update ignores agentId outside _meta['hydra-acp']", async () => {
  const { fn, calls } = captureDispatch();
  const seen: Array<string | undefined> = [];
  const router = new EventRouter(
    (ev) => {
      seen.push(ev.meta.agentId);
      return ev.kind === "turn_complete" ? { title: ev.meta.agentId ?? "?" } : null;
    },
    { sessionId: "hydra_session_x", agentId: "claude-acp" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: {
      sessionUpdate: "session_info_update",
      agentId: "should-be-ignored",
      _meta: { other: { agentId: "also-ignored" } },
    },
  });
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.deepEqual(seen, ["claude-acp", "claude-acp"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "claude-acp");
});

test("setMeta updates the meta passed to the rule", async () => {
  const { fn, calls } = captureDispatch();
  const seen: Array<string | undefined> = [];
  const router = new EventRouter(
    (ev) => {
      seen.push(ev.meta.title);
      return { title: ev.meta.title ?? "untitled" };
    },
    { sessionId: "hydra_session_x", title: "Initial" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  router.setMeta({ sessionId: "hydra_session_x", title: "Renamed" });
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.deepEqual(seen, ["Initial", "Renamed"]);
  assert.equal(calls.length, 2);
});

test("DEFAULT_RULE: fires on turn_complete with agent + cwd in title", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      cwd: "/home/me/proj",
      agentId: "claude-acp",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete", stopReason: "end_turn" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "🐉 claude-acp · abcdef01 · proj");
  assert.equal(calls[0]?.body, "Finished");
});

test("DEFAULT_RULE: prefers session title over cwd basename in heading", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      cwd: "/home/me/proj",
      agentId: "claude-acp",
      title: "Investigating flaky CI",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete", stopReason: "max_tokens" },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.title,
    "🐉 claude-acp · abcdef01 · Investigating flaky CI",
  );
  assert.equal(calls[0]?.body, "Max token limit reached");
});

test("DEFAULT_RULE: omits trailing heading when no title or cwd is known", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      agentId: "claude-acp",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "🐉 claude-acp · abcdef01");
  assert.equal(calls[0]?.body, "Finished");
});

test("DEFAULT_RULE: skips turn_complete carrying the amended _meta marker", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      cwd: "/home/me/proj",
      agentId: "claude-acp",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: {
      sessionUpdate: "turn_complete",
      stopReason: "cancelled",
      _meta: {
        "hydra-acp": {
          amended: {
            cancelledMessageId: "m1",
            newMessageId: "m2",
          },
        },
      },
    },
  });
  assert.equal(calls.length, 0);
});

test("DEFAULT_RULE: still fires on plain cancelled turn_complete with no amend marker", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      agentId: "claude-acp",
    },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "turn_complete", stopReason: "cancelled" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body, "Cancelled");
});

test("DEFAULT_RULE: skips non-turn_complete events", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    { sessionId: "hydra_session_abc" },
    silentLogger(),
    fn,
  );
  await router.onSessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
  });
  await router.onSessionUpdate({
    update: { sessionUpdate: "usage_update", used: 100 },
  });
  await router.onSessionUpdate({
    update: { sessionUpdate: "session_info_update", title: "x" },
  });
  assert.equal(calls.length, 0);
});

test("onAwaitingPermission: routes the toolCall through the rule", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    {
      sessionId: "hydra_session_abcdef0123",
      cwd: "/home/me/proj",
      agentId: "claude-acp",
      title: "Investigating flaky CI",
    },
    silentLogger(),
    fn,
  );
  await router.onAwaitingPermission({
    toolCallId: "tc_1",
    title: "Run ping -c 1",
    kind: "execute",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.title,
    "🔒 claude-acp · abcdef01 · Investigating flaky CI",
  );
  assert.equal(calls[0]?.body, "Awaiting approval: Run ping -c 1");
  assert.equal(calls[0]?.urgency, undefined);
});

test("DEFAULT_RULE: awaiting_permission falls back to name/kind when no title", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    { sessionId: "hydra_session_abcdef0123", agentId: "claude-acp" },
    silentLogger(),
    fn,
  );
  await router.onAwaitingPermission({
    toolCallId: "tc_2",
    name: "edit_file",
    kind: "edit",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body, "Awaiting approval: edit_file");
});

test("DEFAULT_RULE: awaiting_permission with no descriptors falls back to 'tool call'", async () => {
  const { fn, calls } = captureDispatch();
  const router = new EventRouter(
    DEFAULT_RULE,
    { sessionId: "hydra_session_abcdef0123", agentId: "claude-acp" },
    silentLogger(),
    fn,
  );
  await router.onAwaitingPermission({ toolCallId: "tc_3" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body, "Awaiting approval: tool call");
});
