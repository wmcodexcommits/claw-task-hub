#!/usr/bin/env sh
set -eu

# Refuse to push a branch that does not already contain origin/main.
#
# This is hygiene, not the gate. The incident that prompted it (a001271, the
# squash of #7) was NOT caused by a stale branch: that branch sat directly on
# main's tip. The 176 deleted lines of server/db.ts were authored by the local
# merge 4fcfc45, which resolved its conflicts by keeping the older side, and
# the squash then carried that deletion onto main faithfully. CI was red on the
# pull request and it was merged anyway, because no status check was required.
#
# The real gate is the MAINPROTECT ruleset, which now requires the Verification
# Gate and Windows Portability checks to pass before a merge. This hook only
# keeps a branch from drifting far enough that a merge resolution has to make
# that kind of choice in the first place.
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
