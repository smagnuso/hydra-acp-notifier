import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRule, DEFAULT_RULE } from "../src/rule.js";

test("loadRule returns DEFAULT_RULE when file is missing", async () => {
  const fn = await loadRule("/does/not/exist.js");
  assert.equal(fn, DEFAULT_RULE);
});

test("loadRule imports a JS module's default export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notifier-rule-"));
  try {
    const p = join(dir, "rule.js");
    writeFileSync(
      p,
      'export default function notify(ev) { return ev.kind === "turn_complete" ? { title: "done" } : null; }\n',
      "utf8",
    );
    const fn = await loadRule(p);
    assert.notEqual(fn, DEFAULT_RULE);
    const result = await fn({
      sessionId: "s",
      kind: "turn_complete",
      raw: {},
      meta: {},
    });
    assert.deepEqual(result, { title: "done" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRule falls back to DEFAULT_RULE when no default export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notifier-rule-"));
  try {
    const p = join(dir, "rule.js");
    writeFileSync(p, "export const foo = 1;\n", "utf8");
    const fn = await loadRule(p);
    assert.equal(fn, DEFAULT_RULE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Cache-bust reload verified manually under plain `node`; the `tsx` dev
// runner used by `npm test` ignores the cache-busting query param, so
// the assertion would fail here despite working at runtime. See the
// matching comment in hydra-acp-approver.
