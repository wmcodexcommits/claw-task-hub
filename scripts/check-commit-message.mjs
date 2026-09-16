// Reject a commit subject the release bump could not classify.
//
// The bump reads the log to decide the next version, so a subject it cannot
// parse is a change that ships without moving the version. Catching that at
// commit time is the only cheap moment: rewording a message later means
// rewriting history that may already be pushed.

import { readFileSync } from "node:fs";
import { TYPE_BUMP, parseCommit } from "./commit-types.mjs";

const messagePath = process.argv[2];
if (!messagePath) throw new Error("commit-msg hook requires the message file path");

const message = readFileSync(messagePath, "utf8");
// Comment lines are git's own template, not the author's message.
const lines = message.split("\n").filter((line) => !line.startsWith("#"));
const subject = (lines[0] ?? "").trim();
const body = lines.slice(1).join("\n");

if (subject === "") process.exit(0); // An empty message aborts the commit anyway.

const parsed = parseCommit(subject, body);
if (parsed.exempt || parsed.valid) process.exit(0);

const types = Object.entries(TYPE_BUMP)
  .map(([type, bump]) => `  ${type.padEnd(9)} ${bump === "none" ? "no release" : `${bump} release`}`)
  .join("\n");

process.stderr.write(`
commit-msg: "${subject}" is not a Conventional Commit.

  <type>[(scope)][!]: <summary>

${parsed.unknownType ? `"${parsed.unknownType}" is not a known type.\n\n` : ""}Types and what each one releases:
${types}

A trailing "!" or a "BREAKING CHANGE:" body footer forces a major release.

Examples:
  feat(store): add runnable issue queue
  fix(db): restore exports dropped by the squash merge
  hotfix: reject unsafe CORS origins
  feat(api)!: remove the legacy database path

Merge, revert and fixup subjects are exempt.
`);
process.exit(1);
