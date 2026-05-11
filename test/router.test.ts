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
      sessionId: "hydra_session_abc",
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
  assert.match(calls[0]?.title ?? "", /claude-acp.*proj/);
  assert.match(calls[0]?.body ?? "", /end_turn/);
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
