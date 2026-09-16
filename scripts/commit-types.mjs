// The single owner of what a commit subject means for the next version.
//
// Both the commit-msg hook and the release bump read this table, so a message
// that the hook accepts is always a message the bump can classify. Adding a
// type in one place without the other is what makes an automated release
// silently skip work that shipped.

/** type -> the smallest release it forces. */
export const TYPE_BUMP = {
  feat: "minor",

  // Everything that pools into a patch. `hotfix` is its own type rather than a
  // scope of `fix` so an urgent production patch is greppable in the log and
  // lands in its own CHANGELOG group, while still bumping only the patch digit.
  fix: "patch",
  hotfix: "patch",
  perf: "patch",
  revert: "patch",

  // Real work that ships nothing a consumer can observe. Recorded in the
  // release report, never a reason to cut a version on its own.
  docs: "none",
  style: "none",
  refactor: "none",
  test: "none",
  build: "none",
  ci: "none",
  chore: "none",
};

/** CHANGELOG grouping, in the order sections are written. */
export const TYPE_SECTION = {
  feat: "Added",
  fix: "Fixed",
  hotfix: "Fixed (hotfix)",
  perf: "Performance",
  revert: "Reverted",
};

export const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

// A merge commit records an integration, not a change, and its subject is
// written by GitHub rather than by the author. Reverts of a revert and fixup
// commits are likewise not authored subjects. Holding them to the format would
// reject merges nobody can reword.
const EXEMPT = [
  /^Merge /,
  /^Revert "/,
  /^(fixup|squash)! /,
  /^Bump version to /,
];

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<summary>.+)$/;

export function isExempt(subject) {
  return EXEMPT.some((pattern) => pattern.test(subject));
}

/**
 * Classify one commit. `body` is only read for the BREAKING CHANGE footer,
 * which is the Conventional Commits way to force a major without `!`.
 */
export function parseCommit(subject, body = "") {
  if (isExempt(subject)) return { exempt: true, bump: "none", subject };
  const match = SUBJECT.exec(subject);
  if (!match) return { valid: false, bump: "none", subject };

  const { type, scope, breaking, summary } = match.groups;
  if (!(type in TYPE_BUMP)) return { valid: false, unknownType: type, bump: "none", subject };

  const breakingFooter = /^BREAKING[ -]CHANGE:/m.test(body);
  const bump = breaking || breakingFooter ? "major" : TYPE_BUMP[type];
  return { valid: true, type, scope, summary, breaking: Boolean(breaking || breakingFooter), bump, subject };
}

export function nextVersion(current, bump) {
  if (bump === "none") return null;
  const [major, minor, patch] = current.split(".").map((part) => Number.parseInt(part, 10));
  // Strict SemVer at every point in the range, including 0.x: a breaking change
  // is a major and takes 0.2.0 to 1.0.0. Each level resets the ones below it.
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
