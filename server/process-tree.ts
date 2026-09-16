// Process-tree termination for harness runs.
//
// A harness is rarely one process: agent CLIs start shells, test runners, and
// language servers beneath themselves. Stopping only the direct child would
// leave those running with the worktree open, so the hub starts each harness as
// the root of its own tree -- its own process group on POSIX, a tree taskkill can
// walk on Windows -- and always stops the whole tree.
//
// Termination is two-phase, as the execution contract requires: a cooperative
// request, the cancellation grace period, then a forced stop. Only a ChildProcess
// this process spawned can be passed in, which is how the contract's "a process
// the hub cannot prove it started is reported, never killed" holds by
// construction.
//
// Windows has no cooperative signal for console programs: taskkill without /F
// asks windows to close, and console processes ignore it. The request phase is
// therefore best-effort there, and the forced /T /F phase does the work.

import { execFile, type ChildProcess } from "node:child_process";

export type TerminationOutcome = "already_exited" | "exited_after_request" | "forced";

export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<TerminationOutcome> {
  if (hasExited(child)) {
    sweepGroup(child);
    return "already_exited";
  }
  requestStop(child);
  if (graceMs > 0 && (await waitForExit(child, graceMs))) {
    sweepGroup(child);
    return "exited_after_request";
  }
  forceStop(child);
  await waitForExit(child, 5_000);
  return "forced";
}

export function hasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function requestStop(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true }, () => undefined);
    return;
  }
  signalGroup(child, "SIGTERM");
}

function forceStop(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  signalGroup(child, "SIGKILL");
}

// On POSIX the group outlives its leader: descendants that survived the leader's
// exit are still addressable through the group id and are stopped too.
function sweepGroup(child: ChildProcess) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // No remaining group members.
    }
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
