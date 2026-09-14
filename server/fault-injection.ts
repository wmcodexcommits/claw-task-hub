// Crash points for reconciliation tests.
//
// Reconciliation exists for processes that die between two durable writes, and
// the only honest test of it is a process that really dies there. A fault point
// names such a boundary; when fault injection is enabled and the named point is
// reached, the process exits immediately, without cleanup, as a crash would.
// Both variables must be set, so a stray setting cannot take down a hub.

export function faultPoint(name: string) {
  if (process.env.CLAW_TASK_HUB_ENABLE_FAULT_INJECTION !== "1" || process.env.CLAW_TASK_HUB_FAULT_INJECTION !== name) return;
  process.stderr.write(`claw-task-hub: fault injection stopped the process at ${name}\n`);
  process.exit(86);
}
