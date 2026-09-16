import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderExecutionContractMarkdown } from "../server/execution-contract.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(root, "docs", "AGENTIC_HARNESS.md");
const startMarker = "<!-- execution-contract:generated:start -->";
const endMarker = "<!-- execution-contract:generated:end -->";

// Windows checkouts with core.autocrlf rewrite docs with CRLF. Splice and compare
// on LF so drift means the contract changed, not the line endings, and write
// back in whichever ending the file already uses.
const raw = readFileSync(docPath, "utf8");
const current = raw.replace(/\r\n/g, "\n");
const start = current.indexOf(startMarker);
const end = current.indexOf(endMarker);
if (start < 0 || end < start) throw new Error(`docs/AGENTIC_HARNESS.md must contain ${startMarker} followed by ${endMarker}`);

const generated = `${current.slice(0, start + startMarker.length)}\n\n${renderExecutionContractMarkdown()}\n${current.slice(end)}`;
if (process.argv.includes("--check")) {
  if (current !== generated) throw new Error("docs/AGENTIC_HARNESS.md execution contract tables have drifted; run bun run contract:generate");
  console.log("execution contract documentation is current");
} else {
  writeFileSync(docPath, raw.includes("\r\n") ? generated.replace(/\n/g, "\r\n") : generated, "utf8");
  console.log("generated execution contract tables in docs/AGENTIC_HARNESS.md");
}
