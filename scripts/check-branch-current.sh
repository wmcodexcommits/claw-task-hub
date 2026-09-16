#!/usr/bin/env sh
set -eu

# Refuse to push a branch that does not already contain origin/main.
#
# A pull request whose head is behind main and is merged with "Squash and
# merge" replays the head's OLD copy of every file it touches over main. The
# result is a commit made entirely of deletions that reverts work already
# merged, with no conflict and nothing in the PR diff to look at. a001271
# (#7) did exactly that: -176 lines of server/db.ts, and main could no longer
# boot because index.ts still imported what the squash had removed.
#
# GitHub's "Require branches to be up to date before merging" is the gate that
# actually blocks the merge; this hook is the early warning, so the staleness
# is visible at push time rather than after the squash lands on main.
#
# Set CLAW_ALLOW_STALE_PUSH=1 to push anyway.

base_ref=${CLAW_BASE_REF:-origin/main}

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] && exit 0
[ "$branch" = "HEAD" ] && exit 0

# A checkout with no network, or one that has never fetched the base, is not a
# staleness signal -- do not fail the push on it.
git fetch --quiet origin main 2>/dev/null || true
git rev-parse --verify --quiet "$base_ref" >/dev/null || exit 0

if git merge-base --is-ancestor "$base_ref" HEAD; then
  exit 0
fi

behind=$(git rev-list --count "HEAD..$base_ref")

if [ "${CLAW_ALLOW_STALE_PUSH:-}" = "1" ]; then
  printf '%s\n' "check-branch-current: $branch is $behind commit(s) behind $base_ref; pushing anyway (CLAW_ALLOW_STALE_PUSH=1)." >&2
  exit 0
fi

cat >&2 <<MESSAGE
check-branch-current: $branch is $behind commit(s) behind $base_ref.

Merging this branch by squash would replay its older copies of the files it
touches over $base_ref and silently revert work already on main.

Bring the branch current first:

  git fetch origin main
  git merge origin/main      # or: git rebase origin/main

Then re-run the push. To override: CLAW_ALLOW_STALE_PUSH=1 git push
MESSAGE
exit 1
