// Deterministic stand-in for an agent harness, for tests and local end-to-end
// runs of the execution control plane.
//
// It follows the same invocation contract the codex adapter uses --
// `exec --json --cd <dir> --output-last-message <file> -`, instructions on stdin,
// JSONL events on stdout, everything else on stderr -- so the runner's gating,
// capture, bounds, cancellation, and event handling are exercised without a
// model. Instructions are a JSON object; files are written only inside the
// working directory.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Instructions = {
  append_launch?: string;
  write?: { path: string; content: string }[];
  print_env?: string[];
  stdout?: string[];
  stderr?: string[];
  flood_bytes?: number;
  grandchild_heartbeat?: string;
  sleep_ms?: number;
  heartbeat_ms?: number;
  last_message?: string;
  fail_turn?: string;
  exit_code?: number;
};

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("fake-harness 1\n");
} else if (args[0] === "--grandchild") {
  const target = args[1];
  const interval = Number(args[2]) || 100;
  setInterval(() => writeFileSync(target, String(Date.now())), interval);
} else {
  await run();
}

async function run() {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const directory = option("--cd");
  const lastMessagePath = option("--output-last-message");
  if (args[0] !== "exec" || !args.includes("--json") || args[args.length - 1] !== "-" || !directory) {
    process.stderr.write("usage: fake-harness exec --json --cd <dir> [--output-last-message <file>] -\n");
    process.exitCode = 2;
    return;
  }
  if (realpathSync.native(directory) !== realpathSync.native(process.cwd())) {
    process.stderr.write(`fake-harness: --cd ${directory} is not the working directory ${process.cwd()}\n`);
    process.exitCode = 2;
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const instructions = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Instructions;
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

  emit({ type: "thread.started", thread_id: `fake-${process.pid}` });
  emit({ type: "turn.started" });
  if (instructions.append_launch) appendFileSync(inside(instructions.append_launch), `${process.pid}\n`);
  for (const file of instructions.write ?? []) {
    const target = inside(file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  for (const name of instructions.print_env ?? []) process.stdout.write(`${name}=${process.env[name] ?? "unset"}\n`);
  for (const line of instructions.stdout ?? []) process.stdout.write(`${line}\n`);
  for (const line of instructions.stderr ?? []) process.stderr.write(`${line}\n`);
  if (instructions.flood_bytes) process.stdout.write(`${"x".repeat(instructions.flood_bytes)}\n`);
  if (instructions.grandchild_heartbeat) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--grandchild", inside(instructions.grandchild_heartbeat), "100"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  const end = Date.now() + (instructions.sleep_ms ?? 0);
  while (Date.now() < end) {
    await new Promise((settle) => setTimeout(settle, Math.max(1, Math.min(instructions.heartbeat_ms ?? end - Date.now(), end - Date.now()))));
    if (instructions.heartbeat_ms) process.stdout.write(`heartbeat ${Date.now()}\n`);
  }
  if (lastMessagePath && instructions.last_message !== undefined) writeFileSync(lastMessagePath, instructions.last_message);
  if (instructions.fail_turn) emit({ type: "turn.failed", error: { message: instructions.fail_turn } });
  else emit({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } });
  process.exitCode = instructions.exit_code ?? 0;
}

function inside(path: string) {
  const target = resolve(process.cwd(), path);
  const offset = relative(process.cwd(), target);
  if (isAbsolute(path) || offset.startsWith("..") || isAbsolute(offset)) throw new Error(`fake-harness only writes inside its working directory: ${path}`);
  return target;
}
