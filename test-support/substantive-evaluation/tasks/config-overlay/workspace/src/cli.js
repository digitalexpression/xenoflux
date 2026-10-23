import { readFileSync } from "node:fs";
import { resolveConfiguration } from "./config-overlay.js";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const result = resolveConfiguration(input?.layers);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write("Invalid configuration input.\n");
  process.exitCode = 1;
}
