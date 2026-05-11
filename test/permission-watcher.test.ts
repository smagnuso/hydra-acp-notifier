import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PermissionWatcher } from "../src/permission-watcher.js";
import type { Logger } from "../src/util/log.js";
import type { PermissionRequestParams } from "../src/acp/protocol.js";

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function mkReq(toolCallId: string, extras: Record<string, unknown> = {}): PermissionRequestParams {
  return {
    sessionId: "s",
    toolCall: { toolCallId, ...extras },
    options: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("fires onAwaiting when timer elapses with no resolve", async () => {
  const fired: Array<PermissionRequestParams["toolCall"]> = [];
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(
    20,
    (tc) => fired.push(tc),
    silentLogger(),
  );
  watcher.onRequest(mkReq("tc_1", { name: "edit_file" }), (r) =>
    responses.push(r),
  );
  await delay(50);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.toolCallId, "tc_1");
  assert.equal((fired[0] as { name?: string }).name, "edit_file");
  assert.equal(
    responses.length,
    0,
    "timer firing should not respond — the request is still open",
  );
  watcher.shutdown();
});

test("resolved-before-timer cancels timer and responds cancelled", async () => {
  const fired: Array<unknown> = [];
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(
    50,
    (tc) => fired.push(tc),
    silentLogger(),
  );
  watcher.onRequest(mkReq("tc_2"), (r) => responses.push(r));
  watcher.onResolved({ toolCall: { toolCallId: "tc_2" } });
  await delay(80);
  assert.equal(fired.length, 0, "timer should not have fired");
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], { outcome: { outcome: "cancelled" } });
});

test("onResolved with unknown toolCallId is a no-op", async () => {
  const fired: Array<unknown> = [];
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(
    50,
    (tc) => fired.push(tc),
    silentLogger(),
  );
  watcher.onResolved({ toolCall: { toolCallId: "nope" } });
  await delay(10);
  assert.equal(fired.length, 0);
  assert.equal(responses.length, 0);
});

test("request without toolCallId responds cancelled immediately", () => {
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(50, () => {}, silentLogger());
  watcher.onRequest(
    { sessionId: "s", toolCall: { toolCallId: "" }, options: [] },
    (r) => responses.push(r),
  );
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], { outcome: { outcome: "cancelled" } });
});

test("shutdown clears pending timers and responds cancelled", () => {
  const fired: Array<unknown> = [];
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(
    50,
    (tc) => fired.push(tc),
    silentLogger(),
  );
  watcher.onRequest(mkReq("a"), (r) => responses.push(r));
  watcher.onRequest(mkReq("b"), (r) => responses.push(r));
  watcher.shutdown();
  assert.equal(fired.length, 0);
  assert.equal(responses.length, 2);
  for (const r of responses) {
    assert.deepEqual(r, { outcome: { outcome: "cancelled" } });
  }
});

test("duplicate toolCallId replaces the prior pending entry", async () => {
  const fired: Array<unknown> = [];
  const responses: unknown[] = [];
  const watcher = new PermissionWatcher(
    30,
    (tc) => fired.push(tc),
    silentLogger(),
  );
  watcher.onRequest(mkReq("dup"), (r) => responses.push(r));
  watcher.onRequest(mkReq("dup"), (r) => responses.push(r));
  await delay(60);
  // Only the second timer should fire.
  assert.equal(fired.length, 1);
  watcher.shutdown();
});
