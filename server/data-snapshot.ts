import { listManagedDatabases } from "./db.js";
import { listIssueGroups, listProjects, parseIssueDisplayLimit } from "./store.js";

export function dataSnapshot(input: { issues_per_status?: unknown; include_issues?: unknown } = {}) {
  const issueDisplayLimit = parseIssueDisplayLimit(input.issues_per_status);
  const includeIssues = input.include_issues !== false && input.include_issues !== "false";
  const issueGroups = includeIssues ? listIssueGroups({}, issueDisplayLimit) : [];
  return {
    refreshed_at: new Date().toISOString(),
    projects: listProjects(),
    issues: issueGroups.flatMap((group) => group.issues),
    issueGroups,
    issueDisplayLimit,
    databases: listManagedDatabases(),
    includes_issues: includeIssues,
  };
}
