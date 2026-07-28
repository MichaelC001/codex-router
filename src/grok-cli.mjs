import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS_BLOCK_CODES = new Set(["EACCES", "EPERM", "UNKNOWN"]);
const WINDOWS_BLOCK_PATTERNS = [
  /spawn UNKNOWN/i,
  /application control/i,
  /smart app control/i,
  /blocked (?:part of )?this app/i,
  /blocked this file/i,
];

export const GROK_CLI_BLOCKED_DETAIL =
  "installed, but Windows application control appears to have blocked the official Grok CLI";
export const GROK_CLI_BLOCKED_FIX =
  "Keep Smart App Control enabled. Use the grok-api provider, or install a trusted official Grok CLI release that Windows allows.";

function commandPath(name, platform = process.platform) {
  const finder = platform === "win32" ? "where.exe" : "which";
  try {
    return execFileSync(finder, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

export function grokCliPath({
  environment = process.env,
  platform = process.platform,
} = {}) {
  if (environment.GROK_CLI) return environment.GROK_CLI;
  const discovered = commandPath("grok", platform);
  if (discovered) return discovered;

  const directory = path.join(
    environment.GROK_HOME || path.join(os.homedir(), ".grok"),
    "bin",
  );
  const candidates = platform === "win32"
    ? [path.join(directory, "grok.exe"), path.join(directory, "grok")]
    : [
        path.join(os.homedir(), ".npm-global", "bin", "grok"),
        path.join(directory, "grok"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

function launchDiagnostic(result) {
  return [
    result?.error?.code,
    result?.error?.message,
    result?.stderr,
    result?.stdout,
  ]
    .filter(Boolean)
    .join("\n");
}

export function windowsApplicationControlBlocked(result) {
  if (WINDOWS_BLOCK_CODES.has(result?.error?.code)) return true;
  const diagnostic = launchDiagnostic(result);
  return WINDOWS_BLOCK_PATTERNS.some((pattern) => pattern.test(diagnostic));
}

export function grokCliPreflight({
  executable = grokCliPath(),
  environment = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!executable) {
    return {
      state: "missing",
      installed: false,
      runnable: false,
      detail: "official Grok CLI not found",
      fix: "Install @xai-official/grok, then run `grok login --oauth`.",
    };
  }

  // Smart App Control is Windows-specific. Preserve the existing lightweight
  // path check on other platforms instead of launching the CLI during status
  // and doctor commands.
  if (platform !== "win32") {
    return { state: "ready", installed: true, runnable: true, executable };
  }

  const { XAI_API_KEY: _apiKey, ...sanitizedEnvironment } = environment;
  const result = spawnSyncImpl(executable, ["--version"], {
    encoding: "utf8",
    env: sanitizedEnvironment,
    timeout: 5_000,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    return { state: "ready", installed: true, runnable: true, executable };
  }
  if (windowsApplicationControlBlocked(result)) {
    return {
      state: "blocked",
      installed: true,
      runnable: false,
      executable,
      detail: GROK_CLI_BLOCKED_DETAIL,
      fix: GROK_CLI_BLOCKED_FIX,
    };
  }
  return {
    state: "unavailable",
    installed: true,
    runnable: false,
    executable,
    detail: "installed, but the official Grok CLI could not run",
    fix: "Run `grok --version` in a terminal, fix the CLI error, then rerun the doctor.",
  };
}

export function grokCliFailureMessage(status) {
  return `${status.detail}. ${status.fix}`;
}
