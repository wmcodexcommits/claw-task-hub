import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("package.json must define a non-empty version");
}

export const APP_VERSION = packageJson.version;
