// Git variables that point Git at a particular repository, index, or object
// store. Git exports some of them to hooks, so a test run by the pre-commit
// verification gate inherits them. A test that drives its own temporary
// repositories must not: GIT_INDEX_FILE=.git/index makes Git inside a linked
// worktree look for an index at <worktree>/.git/index, which cannot exist
// because a linked worktree's .git is a file. The list matches the one
// server/execution-workspaces.ts strips from the hub's own Git commands.
export const redirectingGitVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

export function withoutRedirectingGitVariables(env = process.env) {
  const copy = { ...env };
  for (const name of redirectingGitVariables) delete copy[name];
  return copy;
}
