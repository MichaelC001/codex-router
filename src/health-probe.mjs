import { probeDelayMs, probeTimeoutMs } from "./health-backoff.mjs";

// Startup gates each service on an HTTP health probe. The loop used to treat
// every failed probe the same, and that was the defect: on loopback, a port
// with nothing behind it refuses instantly, so a refusal is real evidence that
// the service is not up, while a probe we abort ourselves is evidence of
// nothing at all -- something accepted the connection, or this machine was too
// starved to schedule the answer inside the window we allowed. Charging both to
// the same budget let a live, healthy forwarder be declared dead under
// fork/exec contention.
//
// So the two outcomes are handled differently:
//   * refused  -> back off before retrying. Probes are free and the evidence is
//                 conclusive, so the only thing left to manage is the flood of
//                 access-log lines a cold-starting gateway would otherwise get.
//   * aborted  -> retry immediately with a wider window. The probe already
//                 spent its entire timeout waiting, which is backoff enough;
//                 sleeping on top of it only burns budget without learning
//                 anything, and the next probe needs to be *wider*, not later.
//
// The services also announce themselves on stderr ("[api-forwarder] listening"),
// which looks like corroborating evidence, but start.mjs spawns them with
// inherited stdio so that line goes straight to the service log and is not
// readable here without piping and re-forwarding every child's output. That
// would change log ordering for every service and risk a full pipe stalling a
// child, to learn something weaker than the probe already establishes:
// "listening" is not "healthy", and the router wait checks the payload too.
//
// One consequence of a bounded-but-wide window: the last probe of a budget can
// run past the deadline by up to its own window, so a service that accepts
// connections and never answers is reported up to MAX_PROBE_TIMEOUT_MS late.
// That is the right trade -- the alternative is spending the tail of the budget
// on narrow probes that cannot conclude anything -- and it does not apply to a
// service that died, which is reported the instant the child exits.
const PROBE_TIMED_OUT = Symbol("probe timed out");
const CHILD_EXITED = Symbol("child exited");

function hasExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null);
}

/**
 * Poll `url` until the service behind it is healthy.
 *
 * Rejects when the child exits, when startup is interrupted, or when the
 * budget runs out. A probe already in flight is aborted the moment the child
 * exits, so a crash is reported immediately rather than after the probe window
 * and the backoff sleep.
 */
export async function waitForHealth({
  label,
  url,
  headers = {},
  timeoutMs = 30_000,
  expectedService,
  child,
  fetchImpl = fetch,
  isShuttingDown = () => false,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastFailure = "the service never answered";
  let activeProbe = null;
  let wakeSleeper = null;

  const onChildExit = () => {
    // Do not sit out a probe window or a backoff sleep for a process that is
    // already gone: cut both short and let the loop report the exit.
    activeProbe?.abort(CHILD_EXITED);
    wakeSleeper?.();
  };
  if (child) child.once("exit", onChildExit);

  const assertStillStarting = () => {
    if (hasExited(child)) throw new Error(`${label} exited before becoming healthy.`);
    if (isShuttingDown()) throw new Error("Service startup was interrupted.");
  };

  const sleep = (ms) =>
    new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wakeSleeper = null;
        resolve();
      }, ms);
      wakeSleeper = () => {
        clearTimeout(timer);
        wakeSleeper = null;
        resolve();
      };
    });

  try {
    while (Date.now() < deadline) {
      assertStillStarting();

      const windowMs = probeTimeoutMs(attempt);
      const controller = new AbortController();
      const probeTimer = setTimeout(() => controller.abort(PROBE_TIMED_OUT), windowMs);
      activeProbe = controller;
      let timedOut = false;
      try {
        const response = await fetchImpl(url, { headers, signal: controller.signal });
        if (response.ok) {
          if (!expectedService) return;
          const payload = await response.json().catch(() => ({}));
          if (payload.service === expectedService) return;
          lastFailure = `the health response did not identify ${expectedService}`;
        } else {
          lastFailure = `the service answered HTTP ${response.status}`;
        }
      } catch {
        timedOut = controller.signal.reason === PROBE_TIMED_OUT;
        lastFailure = timedOut
          ? `the service did not answer within ${windowMs} ms`
          : "the connection was refused";
      } finally {
        clearTimeout(probeTimer);
        activeProbe = null;
      }

      const wait = timedOut
        ? 0
        : Math.min(probeDelayMs(attempt), Math.max(0, deadline - Date.now()));
      attempt += 1;
      assertStillStarting();
      await sleep(wait);
    }
    throw new Error(`Timed out waiting for ${label} to become healthy (${lastFailure}).`);
  } finally {
    if (child) child.off("exit", onChildExit);
  }
}
