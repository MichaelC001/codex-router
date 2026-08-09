// The Python side of the install is hash-verified: bin/install and install.ps1
// install requirements/python.txt with --require-hashes rather than naming
// packages. These tests fail the moment the lock stops describing
// PYTHON_REQUIREMENTS, which is the failure that stranded the first attempt at
// this work — its pin drifted twelve minor versions behind main and nothing
// noticed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PYTHON_LOCK,
  PYTHON_LOCK_INPUT,
  PYTHON_REQUIREMENTS,
  SOURCE_ROOT,
  installerPythonInstalls,
  installerRequirementDrift,
  lockInputRequirements,
  parseLock,
  pythonLockDrift,
  recordStep,
  stepStatus,
} from "../src/install-plan.mjs";

function repoFile(relative) {
  return path.join(SOURCE_ROOT, ...relative.split("/"));
}

function lockText() {
  return readFileSync(repoFile(PYTHON_LOCK), "utf8");
}

test("the checked-in lock agrees with PYTHON_REQUIREMENTS", () => {
  assert.deepEqual(pythonLockDrift(), []);
});

test("the compile input is exactly the declared requirements", () => {
  assert.deepEqual(lockInputRequirements(), PYTHON_REQUIREMENTS);
});

test("the lock pins the declared versions and nothing else for those projects", () => {
  const entries = parseLock(lockText());
  for (const requirement of PYTHON_REQUIREMENTS) {
    const [specifier, version] = requirement.split("==");
    const name = specifier.replace(/\[[^\]]*\]$/, "").toLowerCase();
    const locked = entries.filter((entry) => entry.project === name);
    assert.ok(locked.length, `${name} is absent from ${PYTHON_LOCK}`);
    for (const entry of locked) {
      assert.equal(entry.version, version, `${name} drifted in ${PYTHON_LOCK}`);
    }
  }
});

test("every pinned distribution in the lock carries a hash", () => {
  const entries = parseLock(lockText());
  // A closure this size is the point: pinning two packages left the rest
  // unverified, so a lock that suddenly holds a handful of entries is a
  // regeneration that lost the transitive tree.
  assert.ok(entries.length > 50, `${PYTHON_LOCK} pins only ${entries.length} distributions`);
  const unhashed = entries.filter((entry) => !entry.hashes);
  assert.deepEqual(unhashed, [], "every requirement must be hash-verified");
});

test("the lock is universal, not one platform's resolution", () => {
  const contents = lockText();
  assert.match(contents, /--universal/, "regenerate with bin/lock-python");
  assert.match(contents, /--generate-hashes/, "regenerate with bin/lock-python");
  // Markers are how one file serves three operating systems; a resolution
  // compiled for the maintainer's laptop has none and installs nowhere else.
  assert.match(contents, /^pywin32==.* ; sys_platform == 'win32'/m);
  assert.match(contents, /^uvloop==.* ; sys_platform != 'win32'/m);
  assert.match(contents, /^\S+==.* ; python_full_version < '3\.11'/m);
});

test("both installers install the lock with hash checking in every branch", () => {
  assert.deepEqual(installerRequirementDrift(), []);
  // Each installer has a uv branch and a pip branch, and a hash-free branch
  // would quietly reopen the gap for anyone without uv.
  for (const script of [path.join("bin", "install"), "install.ps1"]) {
    const contents = readFileSync(path.join(SOURCE_ROOT, script), "utf8");
    assert.equal(
      installerPythonInstalls(contents).length,
      2,
      `${script} must hash-check both its uv and its pip install`,
    );
    // The literals moved into the lock; leaving a copy behind in the shell is
    // exactly the drift #114 was about.
    for (const requirement of PYTHON_REQUIREMENTS) {
      assert.ok(
        !contents.includes(requirement),
        `${script} still names ${requirement}; the lock is the only pin now`,
      );
    }
  }
});

test("a regenerated lock reinstalls even when the pins are unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-"));
  try {
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    const lock = path.join(root, "requirements", "python.txt");
    writeFileSync(lock, lockText());
    const site = path.join(root, ".venv", "lib", "python3.12", "site-packages");
    mkdirSync(site, { recursive: true });
    mkdirSync(path.join(root, ".venv", "bin"), { recursive: true });
    writeFileSync(path.join(root, ".venv", "bin", "python"), "");
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "version_info = 3.12\n");
    for (const requirement of PYTHON_REQUIREMENTS) {
      const [specifier, version] = requirement.split("==");
      const name = specifier.replace(/\[[^\]]*\]$/, "");
      mkdirSync(path.join(site, `${name}-${version}.dist-info`), { recursive: true });
    }

    recordStep("python-deps", { root });
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "skip");

    // A transitive-only bump leaves PYTHON_REQUIREMENTS untouched. Without the
    // lock in the fingerprint the installer would report "already matches" and
    // never apply it.
    writeFileSync(lock, `${lockText()}\n# transitive bump\n`);
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drift in the compile input is reported rather than tolerated", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-drift-"));
  try {
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    writeFileSync(repoFileIn(root, PYTHON_LOCK), lockText());
    writeFileSync(repoFileIn(root, PYTHON_LOCK_INPUT), "litellm[proxy]==1.83.9\n");
    const problems = pythonLockDrift(root);
    assert.ok(
      problems.some((problem) => problem.includes(PYTHON_LOCK_INPUT)),
      `expected an input-drift problem, got: ${problems.join(" | ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unhashed requirement in the lock is reported", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-hash-"));
  try {
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    writeFileSync(repoFileIn(root, PYTHON_LOCK_INPUT), `${PYTHON_REQUIREMENTS.join("\n")}\n`);
    writeFileSync(repoFileIn(root, PYTHON_LOCK), `${lockText()}\nsomething-unpinned==1.0.0\n`);
    const problems = pythonLockDrift(root);
    assert.ok(
      problems.some((problem) => problem.includes("without a hash")),
      `expected an unhashed-requirement problem, got: ${problems.join(" | ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function repoFileIn(root, relative) {
  return path.join(root, ...relative.split("/"));
}
