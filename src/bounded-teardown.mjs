// The supervisor's last step waits for every child to report its exit. That
// wait used to be unbounded: on Windows a child whose exit event never arrives
// (seen after a native 0xC0000409 abort, #1020) left start.mjs alive with no
// children and no listening ports, so the Scheduled Task's RestartOnFailure
// never fired. Bound the wait; the caller exits nonzero when it times out.
export async function awaitChildExits(exits, { timeoutMs }) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(exits).then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
