import { callHubTool, hubToolNames } from "./tool-dispatch.js";

const [, , mode, ...args] = process.argv;

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(raw: string) {
  if (raw.startsWith("base64:")) {
    return JSON.parse(Buffer.from(raw.slice("base64:".length), "base64").toString("utf8"));
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    try {
      return JSON.parse(quotePowerShellObject(raw));
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON arguments: ${message}. On PowerShell, prefer base64:<base64-json>.`);
    }
  }
}

function quotePowerShellObject(raw: string) {
  return raw
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/:\s*([^",{}\s][^,}]*)/g, (_match, value: string) => {
      const trimmed = value.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) return `:${trimmed}`;
      if (/^-?\d+(\.\d+)?$/.test(trimmed) || /^(true|false|null)$/i.test(trimmed)) {
        return `:${trimmed.toLowerCase()}`;
      }
      return `:${JSON.stringify(trimmed)}`;
    });
}

try {
  if (mode === "tools/list") {
    print({ tools: hubToolNames });
  } else if (mode === "tools/call") {
    const [tool, raw = "{}"] = args;
    const input = parseArgs(raw);
    print(await callHubTool(tool, input));
  } else {
    console.error("Usage: bun run hub -- tools/list");
    console.error("   or: bun run hub -- tools/call list_issues '{\"limit\":10}'");
    console.error("   or: bun run hub -- tools/call list_issues base64:<base64-json>");
    process.exit(2);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
