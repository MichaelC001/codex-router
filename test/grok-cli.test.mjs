import assert from "node:assert/strict";
import test from "node:test";

import {
  grokCliFailureMessage,
  grokCliPreflight,
  windowsApplicationControlBlocked,
} from "../src/grok-cli.mjs";
import { refreshWithOfficialCli } from "../src/grok-oauth-session.mjs";

test("Grok CLI preflight distinguishes a missing executable", () => {
  const status = grokCliPreflight({ executable: null });
  assert.equal(status.state, "missing");
  assert.equal(status.installed, false);
  assert.equal(status.runnable, false);
});

test("Grok CLI preflight preserves path-only checks outside Windows", () => {
  let launches = 0;
  const status = grokCliPreflight({
    executable: "/usr/local/bin/grok",
    platform: "darwin",
    spawnSyncImpl: () => {
      launches += 1;
      return { status: 0 };
    },
  });
  assert.equal(status.state, "ready");
  assert.equal(status.runnable, true);
  assert.equal(launches, 0);
});

test("Grok CLI preflight launches a harmless version check on Windows", () => {
  let invocation;
  const status = grokCliPreflight({
    executable: "C:\\tools\\grok.exe",
    environment: { XAI_API_KEY: "must-not-leak", SAFE_VALUE: "present" },
    platform: "win32",
    spawnSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "0.2.112\n" };
    },
  });
  assert.equal(status.state, "ready");
  assert.equal(status.runnable, true);
  assert.equal(invocation.command, "C:\\tools\\grok.exe");
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.options.env.SAFE_VALUE, "present");
  assert.equal("XAI_API_KEY" in invocation.options.env, false);
});

test("Grok CLI preflight identifies the Windows spawn UNKNOWN policy failure", () => {
  const status = grokCliPreflight({
    executable: "grok.cmd",
    platform: "win32",
    spawnSyncImpl: () => ({
      status: 1,
      error: Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN" }),
    }),
  });
  assert.equal(status.state, "blocked");
  assert.equal(status.runnable, false);
  assert.match(status.detail, /application control.*blocked/i);
  assert.match(status.fix, /Smart App Control enabled/);
  assert.match(status.fix, /grok-api/);
  assert.doesNotMatch(grokCliFailureMessage(status), /disable Smart App Control/i);
});

test("Grok CLI preflight recognizes an Application Control stderr message", () => {
  const result = {
    status: 1,
    stderr: "An Application Control policy has blocked this file",
  };
  assert.equal(windowsApplicationControlBlocked(result), true);
  assert.equal(
    grokCliPreflight({
      executable: "grok.exe",
      platform: "win32",
      spawnSyncImpl: () => result,
    }).state,
    "blocked",
  );
});

test("Grok CLI preflight recognizes spawn UNKNOWN from the npm launcher", () => {
  const status = grokCliPreflight({
    executable: "grok.cmd",
    platform: "win32",
    spawnSyncImpl: () => ({ status: 1, stderr: "Error: spawn UNKNOWN" }),
  });
  assert.equal(status.state, "blocked");
});

test("Grok CLI preflight keeps unrelated Windows failures generic", () => {
  const status = grokCliPreflight({
    executable: "grok.exe",
    platform: "win32",
    spawnSyncImpl: () => ({ status: 2, stderr: "invalid installation" }),
  });
  assert.equal(status.state, "unavailable");
  assert.match(status.fix, /grok --version/);
  assert.doesNotMatch(status.detail, /application control/i);
});

test("Grok OAuth refresh surfaces the Windows policy block before token expiry", async () => {
  let refreshLaunches = 0;
  await assert.rejects(
    refreshWithOfficialCli({
      executable: "grok.cmd",
      preflightOptions: {
        platform: "win32",
        spawnSyncImpl: () => ({
          status: 1,
          error: Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN" }),
        }),
      },
      spawnImpl: () => {
        refreshLaunches += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "oauth_unauthorized");
      assert.match(error.message, /application control.*blocked/i);
      assert.match(error.message, /grok-api/);
      return true;
    },
  );
  assert.equal(refreshLaunches, 0);
});
