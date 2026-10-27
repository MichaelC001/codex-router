import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { awaitChildExits } from "../src/bounded-teardown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("teardown reports drained once every child exit settles", async () => {
  const started = Date.now();
  const drained = await awaitChildExits(
    [Promise.resolve({ code: 0 }), new Promise((resolve) => setTimeout(resolve, 20))],
    { timeoutMs: 5_000 },
  );
  assert.equal(drained, true);
  assert.ok(Date.now() - started < 2_000);
});

test("teardown stops waiting for a child whose exit never arrives", async () => {
  const started = Date.now();
  const drained = await awaitChildExits([new Promise(() => {})], { timeoutMs: 50 });
  assert.equal(drained, false);
  assert.ok(Date.now() - started < 2_000);
});

test("a supervisor stuck on a lost child exit still exits nonzero", async () => {
  // Mirrors start.mjs: a live handle (the interval stands in for the Windows
  // child handle whose exit event was lost) keeps the process up, and the
  // bounded wait must still let it exit with a failure code.
  const script = `
    import { awaitChildExits } from ${JSON.stringify(pathToFileURL(path.join(root, "src/bounded-teardown.mjs")).href)};
    setInterval(() => {}, 1_000);
    const drained = await awaitChildExits([new Promise(() => {})], { timeoutMs: 100 });
    if (!drained) process.exit(1);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const started = Date.now();
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5_000);
});
