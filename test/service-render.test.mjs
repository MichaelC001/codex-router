import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceCommand(
  script,
  platform,
  testRoot,
  command = "render",
  target = "codex",
  sourceRoot = root,
) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(
    process.execPath,
    [...nodeArgs, path.join(sourceRoot, "src", script), command],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex home"),
        CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
        MODEL_ROUTER_TARGET: target,
        CODEX_ROUTER_SERVICE_PLATFORM: platform,
        XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
      },
    },
  );
}

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  return serviceCommand(script, platform, testRoot, "render", target, sourceRoot);
}

// Mirrors src/service-windows.mjs: MODEL_ROUTER_STATE_DIR wins over every other
// state-directory source, and the fixture name deliberately carries a space.
function windowsStateDir(testRoot) {
  return path.join(testRoot, "codex router state");
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows launcher starts the wrapper hidden and propagates its exit code", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-launcher-"));
  try {
    const stateDir = windowsStateDir(testRoot);
    assert.ok(stateDir.includes(" "), "the fixture state directory must contain a space");
    const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
    const script = serviceCommand("service-windows.mjs", "win32", testRoot, "render-launcher");

    assert.match(script, /^Option Explicit\r\n/);
    assert.match(script, /\r\nSet shell = CreateObject\("WScript\.Shell"\)\r\n/);
    // Window style 0 hides the wrapper's console; True waits for it so that
    // Run returns the wrapper's exit code instead of returning immediately.
    assert.ok(
      script.includes(
        `status = shell.Run("cmd.exe /D /C " & quote & quote & "${wrapperPath}" & quote & quote, 0, True)\r\n`,
      ),
      `launcher did not embed the wrapper path correctly:\n${script}`,
    );
    // Without this line Task Scheduler reads every crash as a clean exit and
    // the RestartCount/RestartInterval settings never fire again.
    assert.match(script, /\r\nWScript\.Quit status\r\n$/);
    // A failure to even start the wrapper must also surface as a failure.
    assert.match(script, /\r\nIf Err\.Number <> 0 Then\r\n {2}WScript\.Quit 1\r\nEnd If\r\n/);

    // Every generated line must be a valid VBScript statement: string literals
    // escape a double quote by doubling it, so quotes always come in pairs.
    for (const line of script.split("\r\n")) {
      assert.equal(
        (line.match(/"/g) || []).length % 2,
        0,
        `unbalanced quotes in generated line: ${line}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows scheduled task runs the VBS launcher through wscript.exe", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-action-"));
  try {
    const launcherPath = path.join(windowsStateDir(testRoot), "start-codex-router-hidden.vbs");
    const action = JSON.parse(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-task"),
    );

    assert.equal(action.execute, "wscript.exe");
    // //B and //NoLogo keep the windowless host quiet; the launcher path takes a
    // single quote pair because wscript.exe uses the standard argument parser.
    assert.equal(action.argument, `//B //NoLogo "${launcherPath}"`);
    // The console-visible cmd.exe action is what issue #98 reported.
    assert.doesNotMatch(`${action.execute} ${action.argument}`, /cmd\.exe/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test(
  "the Windows installer writes both launchers idempotently and uninstall removes both",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-install-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");
      const run = (command) =>
        JSON.parse(serviceCommand("service-windows.mjs", "win32", testRoot, command));

      // schtasks.exe and powershell.exe are absent off Windows, and every call
      // to them is best effort, so only the generated files are exercised here.
      assert.equal(run("install").installed, true);
      assert.equal(existsSync(wrapperPath), true);
      assert.equal(existsSync(launcherPath), true);

      const bytes = readFileSync(launcherPath);
      // wscript.exe falls back to the ANSI code page without this byte order
      // mark, which corrupts a state directory holding non-ASCII characters.
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
      assert.match(bytes.toString("utf16le").slice(1), /^Option Explicit\r\n/);

      // Reinstalling over an existing pair overwrites instead of failing.
      assert.equal(run("install").installed, true);
      assert.equal(readFileSync(launcherPath).equals(bytes), true);

      assert.equal(run("uninstall").installed, false);
      assert.equal(existsSync(wrapperPath), false);
      assert.equal(existsSync(launcherPath), false);

      // Uninstalling again must not fail on the already-removed launchers.
      assert.equal(run("uninstall").installed, false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
