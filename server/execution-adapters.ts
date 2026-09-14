// Harness-neutral execution adapters.
//
// An adapter knows exactly two things about one agent harness: how to invoke it
// and how to read what it reports. Everything else -- checking the attempt and
// its workspace lease, building the environment, bounding and capturing output,
// cancellation, process-tree termination, and lifecycle transitions -- belongs to
// the runner in server/execution-runs.ts. Supporting Claude or another runner
// therefore means adding an adapter here, never a branch in lifecycle code.
//
// Adapters declare capabilities, and the runner refuses a launch that needs one
// the adapter lacks before any process starts. Every adapter must accept its
// instructions on stdin: that is what lets the runner win the launch transition
// before the harness can act on anything.

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const executionAdapterCapabilities = ["stdin_prompt", "jsonl_events", "final_message_file", "model_selection"] as const;
export type ExecutionAdapterCapability = (typeof executionAdapterCapabilities)[number];

export type AdapterContext = {
  attempt: { id: string; issue_id: string; issue_identifier: string | null; base_sha: string };
  workspace: { worktree_path: string; branch: string; lease_id: string };
  model: string | null;
  final_message_path: string;
};

export type AdapterLocation = { ok: true; command: string; prefixArgs: string[] } | { ok: false; reason: string };

export type AdapterRunReport = { events: number; thread_id: string | null; completed: boolean; failure: string | null };

export type AdapterEventReader = { line(text: string): void; report(): AdapterRunReport };

export type ExecutionAdapter = {
  id: string;
  description: string;
  capabilities: readonly ExecutionAdapterCapability[];
  // Variables that carry credentials. Their values reach the harness, are scrubbed
  // from captured output, and only their names are ever recorded.
  secretEnvironment: readonly string[];
  // Non-secret variables the harness needs, such as its configuration directory.
  passEnvironment: readonly string[];
  locate(): AdapterLocation;
  versionArgs: readonly string[];
  buildArgs(context: AdapterContext): string[];
  readEvents(): AdapterEventReader;
};

// Reads the Codex exec JSONL contract: thread.started carries the thread id,
// turn.completed ends a successful turn, turn.failed and error carry a message.
// Lines that are not JSON objects are ignored rather than trusted.
export function codexEventReader(): AdapterEventReader {
  let events = 0;
  let threadId: string | null = null;
  let completed = false;
  let failure: string | null = null;
  return {
    line(text: string) {
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as { type?: unknown; thread_id?: unknown; message?: unknown; error?: { message?: unknown } };
      if (typeof event.type !== "string") return;
      events += 1;
      if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
      else if (event.type === "turn.completed") completed = true;
      else if (event.type === "turn.failed") failure = String(event.error?.message ?? "turn failed");
      else if (event.type === "error") failure = String(event.message ?? "the harness reported an error");
    },
    report: () => ({ events, thread_id: threadId, completed, failure }),
  };
}

const codexAdapter: ExecutionAdapter = {
  id: "codex",
  description: "OpenAI Codex CLI in non-interactive exec mode with JSONL events, sandboxed to the leased worktree.",
  capabilities: ["stdin_prompt", "jsonl_events", "final_message_file", "model_selection"],
  secretEnvironment: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  passEnvironment: ["CODEX_HOME", "OPENAI_BASE_URL"],
  locate: () => locateExecutable("codex", process.env.CLAW_TASK_HUB_CODEX_BIN, "CLAW_TASK_HUB_CODEX_BIN"),
  versionArgs: ["--version"],
  buildArgs: (context) => [
    "exec",
    "--json",
    "--color",
    "never",
    "--cd",
    context.workspace.worktree_path,
    "--sandbox",
    "workspace-write",
    "--output-last-message",
    context.final_message_path,
    ...(context.model ? ["--model", context.model] : []),
    "-",
  ],
  readEvents: codexEventReader,
};

const fakeHarnessScript = fileURLToPath(new URL("./fake-harness.ts", import.meta.url));

const fakeAdapter: ExecutionAdapter = {
  id: "fake",
  description: "Deterministic harness that follows the Codex exec contract without a model. Available only when CLAW_TASK_HUB_ENABLE_FAKE_HARNESS=1.",
  capabilities: ["stdin_prompt", "jsonl_events", "final_message_file"],
  secretEnvironment: ["CLAW_TASK_HUB_FAKE_HARNESS_SECRET"],
  passEnvironment: [],
  locate: () => (process.env.CLAW_TASK_HUB_ENABLE_FAKE_HARNESS === "1"
    ? { ok: true, command: process.execPath, prefixArgs: [fakeHarnessScript] }
    : { ok: false, reason: "the fake harness is available only when CLAW_TASK_HUB_ENABLE_FAKE_HARNESS=1" }),
  versionArgs: ["--version"],
  buildArgs: (context) => [
    "exec",
    "--json",
    "--cd",
    context.workspace.worktree_path,
    "--output-last-message",
    context.final_message_path,
    "-",
  ],
  readEvents: codexEventReader,
};

const adapters = new Map<string, ExecutionAdapter>([codexAdapter, fakeAdapter].map((adapter) => [adapter.id, adapter]));

export function getExecutionAdapter(id: string) {
  return adapters.get(id) ?? null;
}

export function listExecutionAdapters() {
  return [...adapters.values()].map((adapter) => {
    const location = adapter.locate();
    return {
      id: adapter.id,
      description: adapter.description,
      capabilities: adapter.capabilities,
      available: location.ok,
      unavailable_reason: location.ok ? null : location.reason,
      secret_environment: adapter.secretEnvironment,
      pass_environment: adapter.passEnvironment,
    };
  });
}

// Base variables a harness process needs to start and find its tools. Anything
// not listed here or declared by the adapter is dropped, including the hub's own
// database and connection settings.
const baseEnvironment = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "LC_CTYPE",
  "USER", "USERNAME", "LOGNAME", "SHELL",
];

export type HarnessEnvironment = { env: Record<string, string>; names: string[]; secrets: { name: string; value: string }[] };

// The base allowlist plus any extra names, copied from this process. Names are
// compared case-insensitively: Windows environment names are, and a duplicate
// that differs only in case would make a child's environment ambiguous.
export function allowlistedEnvironment(extraNames: readonly string[] = []) {
  const wanted = new Set([...baseEnvironment, ...extraNames].map((name) => name.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && wanted.has(name.toUpperCase()) && !Object.keys(env).some((existing) => existing.toUpperCase() === name.toUpperCase())) {
      env[name] = value;
    }
  }
  return env;
}

// Every credential value any adapter declares, for scrubbing output that did not
// come from one known harness, such as verification step logs and patches.
export function declaredSecretValues() {
  const names = new Set([...adapters.values()].flatMap((adapter) => adapter.secretEnvironment));
  return [...names]
    .map((name) => ({ name, value: process.env[name] ?? "" }))
    .filter((secret) => secret.value.length >= 4);
}

export function buildHarnessEnvironment(adapter: ExecutionAdapter, context: AdapterContext): HarnessEnvironment {
  const env = allowlistedEnvironment([...adapter.passEnvironment, ...adapter.secretEnvironment]);
  env.CLAW_TASK_HUB_ATTEMPT_ID = context.attempt.id;
  env.CLAW_TASK_HUB_ISSUE = context.attempt.issue_identifier ?? context.attempt.issue_id;
  env.CLAW_TASK_HUB_WORKTREE = context.workspace.worktree_path;
  const secrets = adapter.secretEnvironment
    .map((name) => ({ name, value: process.env[name] ?? "" }))
    .filter((secret) => secret.value.length >= 4);
  return { env, names: Object.keys(env).sort(), secrets };
}

export function locateExecutable(name: string, configured: string | undefined, setting: string): AdapterLocation {
  const explicit = configured?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) return { ok: false, reason: `${setting} must be an absolute path` };
    if (!existsSync(explicit)) return { ok: false, reason: `${setting} points at ${explicit}, which does not exist` };
    if (requiresShell(explicit)) return { ok: false, reason: `${explicit} is a script shim that needs a shell; point ${setting} at the native executable` };
    return { ok: true, command: explicit, prefixArgs: [] };
  }
  const found = searchPath(name);
  if (!found) return { ok: false, reason: `${name} is not on PATH; set ${setting} to its executable` };
  if (requiresShell(found)) return { ok: false, reason: `${found} is a script shim that needs a shell; set ${setting} to the native executable` };
  return { ok: true, command: found, prefixArgs: [] };
}

function requiresShell(path: string) {
  return process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(path);
}

function searchPath(name: string) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
