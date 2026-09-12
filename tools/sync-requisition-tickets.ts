import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "../server/db.js";
import {
  ensureIssueIdentifiers,
  saveComment,
  saveProjectUpdate,
  upsertIssue,
  upsertProject,
} from "../server/store.js";

type RequisitionKind = "alias" | "clause" | "policy" | "source";

type RequisitionRow = {
  id: string;
  kind: RequisitionKind;
  title: string;
  contract: string;
  details_json: string;
  source_keys_json: string;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "../..");
const canonPath = process.env.MAINMCP_CANON_DB ?? resolve(workspaceRoot, "knowledge/db/canon.duckdb");
const projectId = "top-level-requisitions";
const allowedKinds = new Set<RequisitionKind>(["alias", "clause", "policy", "source"]);
const knownFlags = new Set(["--apply", "--check"]);
const suppliedFlags = process.argv.slice(2);

for (const flag of suppliedFlags) {
  if (!knownFlags.has(flag)) throw new Error(`Unknown flag: ${flag}`);
}
if (suppliedFlags.includes("--apply") && suppliedFlags.includes("--check")) {
  throw new Error("Choose either --apply or --check");
}

const mode = suppliedFlags.includes("--apply") ? "apply" : suppliedFlags.includes("--check") ? "check" : "plan";
const requisitions = loadTopLevelRequisitions();
const kindCounts = Object.fromEntries(
  [...allowedKinds].map((kind) => [kind, requisitions.filter((row) => row.kind === kind).length]),
) as Record<RequisitionKind, number>;
const completedCount = kindCounts.alias + kindCounts.source;
const pendingCount = kindCounts.clause + kindCounts.policy;
const expectedProject = {
  id: projectId,
  external_id: projectId,
  name: "Top-Level Requisition Registry",
  summary: `${formatCount(requisitions.length)}/${formatCount(requisitions.length)} top-level registry entries accounted: ${formatCount(completedCount)} completed alias/source records and ${formatCount(pendingCount)} Todo clause/policy obligations.`,
  description: "One stable Claw ticket per unowned top-level kb.requisitions row. These tickets account for authored aliases, shared clauses, policies, and provenance sources without misrepresenting them as algorithm- or math-library implementation requirements.",
  status: "In Progress",
  priority: 1,
};
const existingRows = db.prepare(`
  SELECT id, external_id, identifier, title, description, status, status_type, priority,
         project_id, labels, source, archived_at
  FROM issues
  WHERE external_id LIKE 'top-level-requisitions:%'
`).all() as Array<Record<string, unknown>>;
const existingByExternalId = new Map(existingRows.map((row) => [String(row.external_id), row]));
const expectedExternalIds = new Set(requisitions.map((row) => externalId(row.id)));
const acceptedExternalIds = new Set(
  (db.prepare(`
    SELECT i.external_id
    FROM issues i
    JOIN comments c ON c.issue_id = i.id
    WHERE i.external_id LIKE 'top-level-requisitions:%'
      AND c.external_id = i.external_id || ':accounted'
  `).all() as Array<{ external_id: string }>).map((row) => row.external_id),
);
const missing = requisitions.filter((row) => !existingByExternalId.has(externalId(row.id)));
const orphaned = existingRows.filter((row) => !expectedExternalIds.has(String(row.external_id)));
const mismatched = requisitions.filter((row) => {
  const existing = existingByExternalId.get(externalId(row.id));
  if (!existing) return false;
  const expected = ticketFor(row);
  return existing.title !== expected.title
    || existing.description !== expected.description
    || existing.status !== expected.status
    || existing.status_type !== expected.status_type
    || existing.priority !== expected.priority
    || existing.project_id !== projectId
    || existing.labels !== JSON.stringify(expected.labels)
    || existing.source !== "canon"
    || existing.archived_at !== null
    || !/^CTH-\d+$/.test(String(existing.identifier ?? ""));
});
const missingAcceptance = requisitions.filter((row) => {
  const expected = ticketFor(row);
  return expected.status_type === "completed" && !acceptedExternalIds.has(expected.external_id);
});
const projectRow = db.prepare(`
  SELECT id, external_id, name, summary, description, status, priority, archived_at
  FROM projects
  WHERE id = @id
`).get({ id: projectId }) as Record<string, unknown> | undefined;
const projectMismatch = !projectRow
  || projectRow.external_id !== expectedProject.external_id
  || projectRow.name !== expectedProject.name
  || projectRow.summary !== expectedProject.summary
  || projectRow.description !== expectedProject.description
  || projectRow.status !== expectedProject.status
  || projectRow.priority !== expectedProject.priority
  || projectRow.archived_at !== null;

print({
  mode,
  canon_path: canonPath,
  project_id: projectId,
  total: requisitions.length,
  kinds: kindCounts,
  existing: existingRows.length,
  missing: missing.length,
  mismatched: mismatched.length,
  orphaned: orphaned.length,
  missing_acceptance: missingAcceptance.length,
  project_exists: Boolean(projectRow),
  project_mismatched: projectMismatch,
});

if (mode === "check") {
  db.close();
  process.exit(missing.length || mismatched.length || orphaned.length || missingAcceptance.length || projectMismatch ? 1 : 0);
}
if (mode === "plan") {
  db.close();
  process.exit(0);
}

await upsertProject(expectedProject);

await ensureIssueIdentifiers();
let nextIdentifier = nextIssueNumber();
let created = 0;
let updated = 0;

for (const [index, requisition] of requisitions.entries()) {
  const expected = ticketFor(requisition);
  const existing = existingByExternalId.get(expected.external_id);
  const identifier = typeof existing?.identifier === "string"
    ? existing.identifier
    : `CTH-${String(nextIdentifier++).padStart(3, "0")}`;
  await upsertIssue({
    ...expected,
    identifier,
    project_id: projectId,
    source: "canon",
  });
  if (existing) updated += 1;
  else created += 1;

  if (expected.status_type === "completed") {
    await saveComment({
      external_id: `${expected.external_id}:accounted`,
      issue_id: expected.external_id,
      body: `Acceptance: canonical ${requisition.kind} ${requisition.id} is represented by a stable Claw ticket. This accepts registry accounting only and does not claim implementation of the referenced target.`,
      author: "Codex",
      source: "canon",
      allow_closed: true,
    });
  }

  if ((index + 1) % 250 === 0) {
    process.stderr.write(`synced ${index + 1}/${requisitions.length}\n`);
  }
}

await saveProjectUpdate({
  external_id: "top-level-requisitions:full-accounting",
  project_id: projectId,
  body: `Generated a stable task for every unowned top-level canon requisition: ${kindCounts.alias} aliases, ${kindCounts.clause} clauses, ${kindCounts.policy} policies, and ${kindCounts.source} sources. Alias and source records are Done because their accounting artifacts already exist in canon; clause and policy obligations are Todo. The 696 library-owned requirements remain in their existing algorithm and math projects.`,
  health: "on_track",
  author: "Codex",
  source: "canon",
});

print({ applied: true, created, updated, total: requisitions.length });
db.close();
process.exit(0);

function loadTopLevelRequisitions() {
  const sql = `
    SELECT id, kind, title, contract,
           CAST(details AS VARCHAR) AS details_json,
           CAST(source_keys AS VARCHAR) AS source_keys_json
    FROM kb.requisitions
    WHERE owner IS NULL
    ORDER BY kind, id
  `;
  const result = spawnSync("duckdb", ["-readonly", canonPath, "-json", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `duckdb exited ${result.status}`);
  const rows = JSON.parse(result.stdout) as RequisitionRow[];
  for (const row of rows) {
    if (!allowedKinds.has(row.kind)) throw new Error(`Unsupported top-level requisition kind: ${row.kind}`);
  }
  return rows;
}

function ticketFor(row: RequisitionRow) {
  const completed = row.kind === "alias" || row.kind === "source";
  const details = JSON.stringify(JSON.parse(row.details_json), null, 2);
  const sourceKeys = JSON.stringify(JSON.parse(row.source_keys_json), null, 2);
  return {
    external_id: externalId(row.id),
    title: row.title,
    description: [
      `Canonical requisition: ${row.id}`,
      `Kind: ${row.kind}`,
      "Owner: top-level registry",
      "",
      row.contract,
      "",
      `Details:\n${details}`,
      "",
      `Source keys:\n${sourceKeys}`,
      "",
      completed
        ? "Accounting status: the authored registry artifact exists in canon; Done does not imply implementation of any referenced target."
        : "Accounting status: active shared obligation; Todo means it requires enforcement or review, not library implementation by default.",
    ].join("\n"),
    status: completed ? "Done" : "Todo",
    status_type: completed ? "completed" : "unstarted",
    priority: row.kind === "policy" ? 1 : row.kind === "clause" ? 2 : 3,
    labels: ["canonical-requisition", "top-level-requisition", `requisition-${row.kind}`],
  };
}

function externalId(requisitionId: string) {
  return `${projectId}:${requisitionId}`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function nextIssueNumber() {
  const rows = db.prepare("SELECT identifier FROM issues WHERE identifier LIKE 'CTH-%'").all() as { identifier: string | null }[];
  return rows.reduce((maximum, row) => {
    const match = /^CTH-(\d+)$/.exec(row.identifier ?? "");
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
