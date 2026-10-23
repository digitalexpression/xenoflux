import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolveConfiguration } from "../src/config-overlay.js";

test("maps merge recursively, arrays replace, and provenance tracks winning leaves", () => {
  const result = resolveConfiguration([
    { source: "base", values: { server: { host: "local", ports: [80, 81] }, enabled: true } },
    { source: "team", values: { server: { host: "team", ports: [443] } } },
  ]);
  assert.deepEqual(result.config, { server: { host: "team", ports: [443] }, enabled: true });
  assert.deepEqual(result.provenance, {
    "/server/host": "team",
    "/server/ports": "team",
    "/enabled": "base",
  });
});

test("null clears an inherited property and does not appear in provenance", () => {
  const result = resolveConfiguration([
    { source: "base", values: { token: "synthetic-token", keep: 1 } },
    { source: "override", values: { token: null } },
  ]);
  assert.deepEqual(result.config, { keep: 1 });
  assert.deepEqual(result.provenance, { "/keep": "base" });
});

test("CLI reads JSON from stdin and emits the resolver result", () => {
  const run = spawnSync(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname], {
    input: JSON.stringify({ layers: [{ source: "cli", values: { mode: "safe" } }] }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    config: { mode: "safe" }, provenance: { "/mode": "cli" },
  });
});
