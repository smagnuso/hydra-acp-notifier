import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  dispatchNotification,
  planNotification,
  type SpawnFn,
} from "../src/notify.js";

const WIN_ENV = { SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv;

function decodeScript(args: string[]): string {
  const i = args.indexOf("-EncodedCommand");
  assert.notEqual(i, -1, "expected -EncodedCommand");
  return Buffer.from(args[i + 1]!, "base64").toString("utf16le");
}

test("linux plans notify-send with urgency, icon and body", () => {
  const plan = planNotification(
    { title: "t", body: "b", urgency: "critical", icon: "dialog-information" },
    {},
    "linux",
  );
  assert.deepEqual(plan, {
    cmd: "notify-send",
    args: ["-u", "critical", "-i", "dialog-information", "-a", "hydra-acp", "t", "b"],
  });
});

test("macOS plans osascript with escaped quotes", () => {
  const plan = planNotification({ title: 'say "hi"', body: "b" }, {}, "darwin");
  assert.equal(plan?.cmd, "osascript");
  assert.equal(
    plan?.args[1],
    'display notification "b" with title "say \\"hi\\""',
  );
});

test("windows plans a Windows PowerShell toast by full path", () => {
  const plan = planNotification({ title: "T", body: "B" }, WIN_ENV, "win32");
  assert.equal(
    plan?.cmd,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(plan?.args.slice(0, 6), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
  ]);
  assert.equal(plan?.env?.["HYDRA_ACP_TOAST_TITLE"], "T");
  assert.equal(plan?.env?.["HYDRA_ACP_TOAST_BODY"], "B");
  // The rest of the environment still reaches the child.
  assert.equal(plan?.env?.["SystemRoot"], "C:\\Windows");
});

test("windows falls back to a bare powershell.exe with no SystemRoot", () => {
  const plan = planNotification({ title: "T" }, {}, "win32");
  assert.equal(plan?.cmd, "powershell.exe");
  assert.equal(plan?.env?.["HYDRA_ACP_TOAST_BODY"], "");
});

// Agent output reaches the title and body, so none of it may land in the
// script text. It travels in the environment and is read there.
test("the toast script never contains the notification text", () => {
  const hostile = `'; Remove-Item -Recurse C:\\ ; '"<x>&`;
  const plan = planNotification({ title: hostile, body: hostile }, WIN_ENV, "win32");
  const script = decodeScript(plan!.args);
  assert.ok(!script.includes("Remove-Item"));
  assert.ok(script.includes("$env:HYDRA_ACP_TOAST_TITLE"));
  assert.ok(script.includes("$env:HYDRA_ACP_TOAST_BODY"));
  assert.equal(plan!.env?.["HYDRA_ACP_TOAST_TITLE"], hostile);
});

test("the toast script is the same for every notification", () => {
  const a = planNotification({ title: "one" }, WIN_ENV, "win32")!;
  const b = planNotification({ title: "two", body: "x" }, WIN_ENV, "win32")!;
  assert.equal(decodeScript(a.args), decodeScript(b.args));
});

test("toast text is capped so the environment block cannot overflow", () => {
  const plan = planNotification(
    { title: "t".repeat(5000), body: "b".repeat(50000) },
    WIN_ENV,
    "win32",
  );
  assert.equal(plan?.env?.["HYDRA_ACP_TOAST_TITLE"]?.length, 200);
  assert.equal(plan?.env?.["HYDRA_ACP_TOAST_BODY"]?.length, 1000);
});

test("HYDRA_ACP_NOTIFY_CMD and a per-notification command both outrank the platform default", () => {
  const env = { HYDRA_ACP_NOTIFY_CMD: "mynotify" } as NodeJS.ProcessEnv;
  assert.deepEqual(planNotification({ title: "t", body: "b" }, env, "win32"), {
    cmd: "mynotify",
    args: ["t", "b"],
  });
  assert.deepEqual(
    planNotification(
      { title: "t", command: { cmd: "ntfy", args: ["pub", "x"] } },
      env,
      "win32",
    ),
    { cmd: "ntfy", args: ["pub", "x"] },
  );
});

test("an unknown platform plans nothing", () => {
  assert.equal(planNotification({ title: "t" }, {}, "aix"), null);
});

function fakeChild(): ChildProcess {
  return {
    stderr: null,
    on: () => undefined,
    unref: () => undefined,
  } as unknown as ChildProcess;
}

function capture(): { calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }>; fn: SpawnFn } {
  const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  return {
    calls,
    fn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return fakeChild();
    },
  };
}

// detached:true gives the child DETACHED_PROCESS on Windows, which makes
// windowsHide a no-op and flashes a console for every notification.
test("on windows the child is hidden and not detached", () => {
  const { calls, fn } = capture();
  dispatchNotification({ title: "t" }, { platform: "win32", env: WIN_ENV, spawn: fn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.opts.windowsHide, true);
  assert.equal(calls[0]!.opts.detached, false);
  assert.deepEqual(calls[0]!.opts.stdio, ["ignore", "ignore", "pipe"]);
});

test("off windows the child stays detached with stdio ignored", () => {
  const { calls, fn } = capture();
  dispatchNotification({ title: "t" }, { platform: "linux", env: {}, spawn: fn });
  assert.equal(calls[0]!.opts.detached, true);
  assert.equal(calls[0]!.opts.stdio, "ignore");
});

test("an unknown platform spawns nothing", () => {
  const { calls, fn } = capture();
  dispatchNotification({ title: "t" }, { platform: "aix", env: {}, spawn: fn });
  assert.equal(calls.length, 0);
});

test("a spawn that throws does not escape the dispatcher", () => {
  assert.doesNotThrow(() =>
    dispatchNotification(
      { title: "t" },
      {
        platform: "linux",
        env: {},
        spawn: () => {
          throw new Error("boom");
        },
      },
    ),
  );
});
