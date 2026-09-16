// Decide the next version from the commits since the last release tag, and
// optionally apply it.
//
// The version is derived, never typed: reading it off the log is what keeps
// package.json, the tag and the CHANGELOG heading from disagreeing, which is
// the failure check-release-version.mjs exists to catch after the fact.
//
//   bun run release:next              report the bump and next version
//   bun run release:next -- --apply   write package.json + CHANGELOG
//   bun run release:next -- --apply --release-as 1.0.0    override
//
// It does NOT write changelog prose. Entries here are hand-authored and say
// why a change was made; a generated list of subjects would be strictly worse.
// It promotes whatever is under "## Unreleased" into the new version section
// and opens a fresh empty one.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUMP_RANK, TYPE_SECTION, nextVersion, parseCommit } from "./commit-types.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const releaseAs = args.includes("--release-as") ? args[args.indexOf("--release-as") + 1] : null;

function git(...a) {
  const r = spawnSync("git", a, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const packagePath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const current = packageJson.version;

// describe --abbrev=0 finds the most recent reachable tag; with none, take the
// whole history, which is correct for a first release.
const lastTag = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*.*.*"],
  { cwd: root, encoding: "utf8" }).stdout.trim();
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";

// %x00 separates subject from body, %x01 separates commits: neither can occur
// in a message, unlike the newlines a body is full of.
const raw = git("log", "--no-merges", "--format=%s%x00%b%x01", range);
const commits = raw.split("\x01").map((e) => e.trim()).filter(Boolean)
  .map((entry) => { const [subject, body = ""] = entry.split("\x00"); return parseCommit(subject.trim(), body); });

let bump = "none";
const unparsed = [];
for (const commit of commits) {
  if (commit.valid === false) { unparsed.push(commit.subject); continue; }
  if (BUMP_RANK[commit.bump] > BUMP_RANK[bump]) bump = commit.bump;
}

const computed = nextVersion(current, bump);
const target = releaseAs ?? computed;


const groups = new Map();
for (const commit of commits) {
  if (commit.valid !== true) continue;
  const section = commit.breaking ? "Breaking" : TYPE_SECTION[commit.type];
  if (!section) continue;
  if (!groups.has(section)) groups.set(section, []);
  groups.get(section).push(commit);
}

console.log(`Range:    ${lastTag || "(no tag)"}..HEAD  -- ${commits.length} commit(s)`);
for (const [section, list] of groups) console.log(`  ${section.padEnd(16)} ${list.length}`);
if (unparsed.length) {
  console.log(`\n  ${unparsed.length} commit(s) the bump could not classify (they release nothing):`);
  for (const subject of unparsed.slice(0, 8)) console.log(`    ${subject}`);
}
console.log(`\nBump:     ${bump}`);
console.log(`Version:  ${current} -> ${target ?? "(no release)"}${releaseAs ? "  (overridden)" : ""}`);

if (!apply) process.exit(0);
if (!target) { console.log("\nNothing to release."); process.exit(0); }

packageJson.version = target;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (!changelog.includes("## Unreleased")) throw new Error("CHANGELOG.md has no '## Unreleased' section to promote");
const today = new Date().toISOString().slice(0, 10);
writeFileSync(changelogPath, changelog.replace("## Unreleased", `## Unreleased\n\n## [${target}] - ${today}`));

console.log(`\nApplied. package.json is ${target} and CHANGELOG.md has a [${target}] section.`);
console.log(`Next:     git commit -am "chore: release ${target}" && git tag v${target} && git push --follow-tags`);
