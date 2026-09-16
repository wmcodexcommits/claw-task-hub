import { spawnSync } from "node:child_process";

// A child killed by a signal keeps exitCode === null for good; signalCode is
// what it sets instead. Testing only exitCode makes a second stop attempt wait
// on an "exit" event that already fired, time out, and report a live process
// tree that is in fact long dead.
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(exited);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
    child.once("close", () => finish(true));
  });
}

export async function stopProcessTree(child) {
  if (!child?.pid || hasExited(child)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  if (await waitForExit(child, 3000)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (!(await waitForExit(child, 1000))) {
    throw new Error(`Process tree ${child.pid} did not exit before cleanup`);
  }
}
