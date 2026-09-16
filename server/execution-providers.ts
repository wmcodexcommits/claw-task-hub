// Pull request providers for acceptance.
//
// Opening and merging a pull request are remote mutations. They happen only when
// an acceptance policy names a provider and grants the authority, and only with
// credentials the operator supplies through the environment. A provider never
// records a credential value: it declares the variable names it reads, passes
// them to its own process through the environment allowlist, and everything it
// reports back is scrubbed of their values.
//
// `github` drives the GitHub CLI. `fake` is a deterministic provider for tests
// and dry runs, available only with CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER=1; it
// keeps its pull requests in a JSON file next to the database and never touches
// the network.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveDbPath } from "./db.js";
import { allowlistedEnvironment, locateExecutable } from "./execution-adapters.js";
import { scrub } from "./execution-runs.js";

const execFileAsync = promisify(execFile);
const providerTimeoutMs = 120_000;

export type PullRequestRequest = { repository: string; head: string; base: string; title: string; body: string; cwd: string };
export type PullRequestIdentity = { provider: string; number: number; url: string };
export type MergeResult = { status: "merged"; merge_commit: string | null } | { status: "conflict"; detail: string };
export type ProviderAvailability = { ok: true } | { ok: false; reason: string };

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ExecutionProvider = {
  id: string;
  description: string;
  secretEnvironment: readonly string[];
  available(): ProviderAvailability;
  findPullRequest(request: PullRequestRequest): Promise<PullRequestIdentity | null>;
  createPullRequest(request: PullRequestRequest): Promise<PullRequestIdentity>;
  mergePullRequest(request: PullRequestRequest, pullRequest: PullRequestIdentity): Promise<MergeResult>;
};

// --- fake -----------------------------------------------------------------------------

type FakePull = { number: number; repository: string; head: string; base: string; state: "open" | "merged"; merge_commit: string | null };
type FakeState = { next: number; pulls: FakePull[] };

function fakeStatePath() {
  return join(dirname(resolveDbPath()), "fake-provider", "pull-requests.json");
}

function readFakeState(): FakeState {
  const path = fakeStatePath();
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as FakeState : { next: 1, pulls: [] };
}

function writeFakeState(state: FakeState) {
  const path = fakeStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

const fakeIdentity = (pull: FakePull): PullRequestIdentity => ({ provider: "fake", number: pull.number, url: `fake://pull-requests/${pull.number}` });

const fakeProvider: ExecutionProvider = {
  id: "fake",
  description: "Deterministic local provider for tests; records pull requests in a file and never uses the network.",
  secretEnvironment: ["CLAW_TASK_HUB_FAKE_PROVIDER_TOKEN"],
  available: () => (process.env.CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER === "1"
    ? { ok: true }
    : { ok: false, reason: "the fake provider is available only when CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER=1" }),
  async findPullRequest(request) {
    const pull = readFakeState().pulls.find((candidate) => candidate.repository === request.repository && candidate.head === request.head && candidate.base === request.base);
    return pull ? fakeIdentity(pull) : null;
  },
  async createPullRequest(request) {
    const state = readFakeState();
    const pull: FakePull = { number: state.next, repository: request.repository, head: request.head, base: request.base, state: "open", merge_commit: null };
    state.next += 1;
    state.pulls.push(pull);
    writeFakeState(state);
    return fakeIdentity(pull);
  },
  async mergePullRequest(_request, pullRequest) {
    const state = readFakeState();
    const pull = state.pulls.find((candidate) => candidate.number === pullRequest.number);
    if (!pull) throw new ProviderError(`fake pull request ${pullRequest.number} does not exist`);
    if (process.env.CLAW_TASK_HUB_FAKE_PROVIDER_MERGE === "conflict") return { status: "conflict", detail: "the fake provider was told to report a merge conflict" };
    pull.state = "merged";
    pull.merge_commit ??= `fake-merge-${pull.number}`;
    writeFakeState(state);
    return { status: "merged", merge_commit: pull.merge_commit };
  },
};

// --- github -----------------------------------------------------------------------------

const githubSecrets = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

function githubSlug(repository: string) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repository);
  if (!match) throw new ProviderError(`${repository} is not a GitHub repository`);
  return `${match[1]}/${match[2]}`;
}

async function gh(args: string[], cwd: string) {
  const location = locateExecutable("gh", process.env.CLAW_TASK_HUB_GH_BIN, "CLAW_TASK_HUB_GH_BIN");
  if (!location.ok) throw new ProviderError(location.reason);
  const secrets = providerSecretValues();
  try {
    const { stdout } = await execFileAsync(location.command, args, {
      cwd,
      env: { ...allowlistedEnvironment([...githubSecrets, "GH_HOST", "GH_CONFIG_DIR"]), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      timeout: providerTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return scrub(stdout, secrets);
  } catch (error) {
    const failure = (error ?? {}) as { stderr?: unknown; message?: unknown };
    throw new ProviderError(scrub(String(failure.stderr || failure.message || "gh failed"), secrets).slice(0, 2000));
  }
}

const githubProvider: ExecutionProvider = {
  id: "github",
  description: "GitHub pull requests through the GitHub CLI (gh), authenticated by GH_TOKEN or GITHUB_TOKEN.",
  secretEnvironment: githubSecrets,
  available() {
    const location = locateExecutable("gh", process.env.CLAW_TASK_HUB_GH_BIN, "CLAW_TASK_HUB_GH_BIN");
    if (!location.ok) return { ok: false, reason: location.reason };
    if (!githubSecrets.some((name) => (process.env[name] ?? "").length >= 4)) return { ok: false, reason: "set GH_TOKEN or GITHUB_TOKEN to authorize GitHub pull requests" };
    return { ok: true };
  },
  async findPullRequest(request) {
    const output = await gh(["pr", "list", "--repo", githubSlug(request.repository), "--head", request.head, "--base", request.base, "--state", "all", "--json", "number,url", "--limit", "1"], request.cwd);
    const [pull] = JSON.parse(output || "[]") as { number: number; url: string }[];
    return pull ? { provider: "github", number: pull.number, url: pull.url } : null;
  },
  async createPullRequest(request) {
    const output = await gh(["pr", "create", "--repo", githubSlug(request.repository), "--head", request.head, "--base", request.base, "--title", request.title, "--body", request.body], request.cwd);
    const url = output.trim().split(/\r?\n/).at(-1) ?? "";
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!Number.isSafeInteger(number)) throw new ProviderError(`gh did not report the pull request it created: ${url.slice(0, 200)}`);
    return { provider: "github", number, url };
  },
  async mergePullRequest(request, pullRequest) {
    const slug = githubSlug(request.repository);
    try {
      await gh(["pr", "merge", String(pullRequest.number), "--repo", slug, "--merge"], request.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not mergeable|merge conflict|conflicts/i.test(message)) return { status: "conflict", detail: message };
      throw error;
    }
    const view = JSON.parse(await gh(["pr", "view", String(pullRequest.number), "--repo", slug, "--json", "mergeCommit"], request.cwd) || "{}") as { mergeCommit?: { oid?: string } | null };
    return { status: "merged", merge_commit: view.mergeCommit?.oid ?? null };
  },
};

// --- registry -------------------------------------------------------------------------------

const providers = new Map<string, ExecutionProvider>([[githubProvider.id, githubProvider], [fakeProvider.id, fakeProvider]]);

export function getExecutionProvider(id: string) {
  return providers.get(id) ?? null;
}

export const executionProviderIds = [...providers.keys()];

export function listExecutionProviders() {
  return [...providers.values()].map((provider) => {
    const availability = provider.available();
    return {
      id: provider.id,
      description: provider.description,
      available: availability.ok,
      unavailable_reason: availability.ok ? null : availability.reason,
      secret_environment: provider.secretEnvironment,
    };
  });
}

// Every credential value any provider declares, for scrubbing Git and provider
// output that acceptance stores or reports.
export function providerSecretValues() {
  const names = new Set([...providers.values()].flatMap((provider) => provider.secretEnvironment));
  return [...names].map((name) => ({ name, value: process.env[name] ?? "" })).filter((secret) => secret.value.length >= 4);
}
