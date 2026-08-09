import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRTY_PREVIEW_LIMIT, localModificationsMessage } from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Nothing on a non-Windows machine can execute PowerShell -- the parse test in
// this file is skipped off Windows for exactly that reason -- so the Windows
// assertions here read the shipped scripts as text instead. That still catches
// the class of defect at issue: wrappers that silently drop the arguments they
// were handed, and a refusal message that drifts from the one it mirrors.
function windowsSwitchBranches(source) {
  const start = source.indexOf("switch ($Command) {");
  assert.notEqual(start, -1, "codex-router.ps1 must dispatch on $Command");
  const body = source.slice(start);
  const branches = new Map();
  const opener = /"([a-z-]+)"\s*\{/g;
  let match;
  while ((match = opener.exec(body))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < body.length) {
      if (body[index] === "{") depth += 1;
      else if (body[index] === "}") depth -= 1;
      index += 1;
    }
    branches.set(match[1], body.slice(opener.lastIndex, index - 1));
  }
  return branches;
}

// A comment may legitimately name a command the code must never run.
function withoutComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

// PowerShell forwards an argument array either as a value ($Arguments) or by
// splatting it into a named-parameter call (@Arguments); both count.
const FORWARDS_ARGUMENTS = /[@$]Arguments\b/;

test("install.sh is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", path.join(root, "install.sh")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "install.ps1 parses under powershell.exe",
  { skip: process.platform !== "win32" },
  () => {
    // The POSIX installer is covered by `sh -n` everywhere, but nothing on a
    // non-Windows machine can parse install.ps1 -- it ships edits that no
    // developer without Windows can validate. Running the real parser here is
    // the only place that gap closes.
    const escaped = path.join(root, "install.ps1").replaceAll("'", "''");
    const check = [
      "$tokens = $null; $errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  },
);

test("both installers keep the update when setup reports exit 2", () => {
  // setup.mjs exits 2 for "the checkout is healthy, configuration is
  // unfinished". The number is the contract between three files that cannot
  // import each other, so losing the branch in either installer silently
  // restores the trap where a declined prompt discards the code update.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.match(posix, /setup_status["\s]*-eq["\s]*2/);
  assert.match(windows, /\$SetupExitCode\s+-eq\s+2/);

  // The rollback must stay reachable for every other non-zero status, so an
  // unrecognized failure still restores the previous revision.
  assert.match(posix, /switch --detach "\$previous_revision"/);
  assert.match(windows, /switch --detach \$PreviousRevision/);
});

test("the kept-update message names the way back", () => {
  // Keeping the update on exit 2 is the right default, but a user who wanted
  // the old revision needs to be told the escape hatch exists; the retained
  // ref is invisible otherwise.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(posix, /\.\/bin\/rollback/);
  assert.match(windows, /codex-router\.ps1 rollback/);
});

test("the Windows wrapper hands every command its own arguments", () => {
  // A hardcoded argument list is invisible: the command still runs, it just
  // runs without the flag the caller typed. `rollback --force` was lost this
  // way, leaving a Windows user with tracked edits no documented route to the
  // force path at all.
  const branches = windowsSwitchBranches(
    readFileSync(path.join(root, "codex-router.ps1"), "utf8"),
  );
  assert.ok(branches.size >= 16, `only found ${branches.size} branches`);

  // bin/enable, bin/disable, and bin/uninstall accept no arguments, so their
  // branches pass fixed node subcommand names rather than user input.
  const takesNoArguments = new Set(["enable", "disable", "uninstall"]);
  for (const [command, body] of branches) {
    if (takesNoArguments.has(command)) {
      assert.equal(
        FORWARDS_ARGUMENTS.test(body),
        false,
        `the ${command} branch forwards arguments its POSIX counterpart rejects`,
      );
      continue;
    }
    assert.ok(
      FORWARDS_ARGUMENTS.test(body),
      `the ${command} branch drops the caller's arguments`,
    );
  }
});

test("rollback --force reaches the updater on Windows", () => {
  // bin/rollback runs `update.mjs rollback "$@"`: the subcommand is fixed and
  // the caller's flags are appended to it. Replacing the whole list with
  // @("rollback") is what silently dropped --force.
  const branches = windowsSwitchBranches(
    readFileSync(path.join(root, "codex-router.ps1"), "utf8"),
  );
  assert.match(branches.get("rollback"), /@\("rollback"\)\s*\+\s*\$Arguments/);
});

test("the bootstrap installer refuses on tracked edits only", () => {
  // install.ps1 run without -CheckoutInstall is the irm|iex self-update path.
  // It reimplements requireReplaceableCheckout() because it may be running as a
  // piped script with no checkout to import from -- so it has to agree with it.
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(windows, /status --porcelain --untracked-files=no/);
  assert.equal(
    /status --porcelain(?! --untracked-files=no)/.test(windows),
    false,
    "an untracked-file-counting status check is back in install.ps1",
  );
});

test("the bootstrap installer's refusal says what src/update.mjs says", () => {
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  const reference = localModificationsMessage([" M src/router.mjs"], "/tmp/checkout");

  // Sentence for sentence against the Node original, so a reword on one side
  // has to be made on both. The divergence is the bug: install.ps1 kept the
  // pre-fix "has local changes" wording, which names no file and no way out.
  assert.ok(reference.startsWith("The checkout has local changes to 1 tracked file;"));
  assert.match(
    windows,
    /"The checkout has local changes to \$\(\$Changes\.Count\) tracked file\$\{Plural\}; refusing to replace them during update:"/,
  );
  assert.equal(windows.includes("has local changes; automatic update"), false);

  assert.match(reference, /^Keep them: {4}git -C \/tmp\/checkout stash$/m);
  assert.match(windows, /"Keep them: {4}git -C \$Directory stash"/);
  assert.match(reference, /^Discard them: re-run the same command with --force$/m);
  assert.match(windows, /"Discard them: re-run the same command with -Force"/);

  // The preview-and-count behaviour, so a checkout with 40 edited files still
  // prints a readable error.
  assert.match(windows, /Select-Object -First \$DirtyPreviewLimit/);
  assert.match(windows, /"  \.\.\.and \$Remainder more"/);
  const declared = windows.match(/^\$DirtyPreviewLimit = (\d+)$/m);
  assert.ok(declared, "install.ps1 must declare $DirtyPreviewLimit");
  assert.equal(Number(declared[1]), DIRTY_PREVIEW_LIMIT);
});

test("the bootstrap installer's force path cannot destroy untracked files", () => {
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  const node = readFileSync(path.join(root, "src", "update.mjs"), "utf8");

  assert.match(windows, /^\s*\[switch\]\$Force,$/m);
  assert.match(windows, /if \(-not \$Force\) \{ throw \(Get-LocalModificationMessage/);
  // `reset --hard` restores tracked files and leaves untracked ones alone.
  assert.match(windows, /git -C \$Directory reset --hard HEAD/);
  // `git clean` would delete work git was never asked to track. update.mjs has
  // no such call and neither may the installer that mirrors it.
  for (const [name, source] of [["install.ps1", windows], ["src/update.mjs", node]]) {
    assert.equal(
      /git\b[^\n]*\bclean\b/.test(withoutComments(source)),
      false,
      `${name} must not run git clean`,
    );
  }
});

test("the documented rollback behaviour matches the exit-2 contract", () => {
  // The docs previously said a failed install always restores the previous
  // revision, which stopped being true when exit 2 was introduced.
  const docs = readFileSync(path.join(root, "docs", "INSTALL.md"), "utf8");
  assert.match(docs, /exits 2/);
  assert.match(docs, /the update is kept/);
});
