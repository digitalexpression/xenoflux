import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.EVAL_WORKSPACE;
if (!root) throw new Error("EVAL_WORKSPACE is required");
const moduleUrl = pathToFileURL(path.join(root, "src/config-overlay.js"));
const { resolveConfiguration } = await import(moduleUrl.href);

test("empty input, empty maps, and RFC 6901 key escaping are deterministic", () => {
  assert.deepEqual(resolveConfiguration([]), { config: {}, provenance: {} });
  const got = resolveConfiguration([
    { source: "empty", values: { blank: {} } },
    { source: "slash", values: { "a/b~c": "value" } },
  ]);
  assert.deepEqual(got.config, { blank: {}, "a/b~c": "value" });
  assert.deepEqual(got.provenance, { "/a~1b~0c": "slash" });
});

test("clears remove descendants, while later maps can restore only supplied leaves", () => {
  const got = resolveConfiguration([
    { source: "base", values: { service: { auth: { user: "demo", pass: "synthetic" }, retries: 2 } } },
    { source: "clear", values: { service: { auth: null } } },
    { source: "restore", values: { service: { auth: { user: "guest" } } } },
  ]);
  assert.deepEqual(got.config, { service: { auth: { user: "guest" }, retries: 2 } });
  assert.deepEqual(got.provenance, {
    "/service/auth/user": "restore",
    "/service/retries": "base",
  });
});

test("a later scalar or list replacing a map removes stale descendant provenance", () => {
  const got = resolveConfiguration([
    { source: "base", values: { endpoint: { host: "x" } } },
    { source: "list", values: { endpoint: ["a", "b"] } },
  ]);
  assert.deepEqual(got.config, { endpoint: ["a", "b"] });
  assert.deepEqual(got.provenance, { "/endpoint": "list" });
});

test("a later map replacing a scalar or list records only the resulting leaf provenance", () => {
  for (const initial of ["old", ["old"]]) {
    const got = resolveConfiguration([
      { source: "base", values: { endpoint: initial } },
      { source: "map", values: { endpoint: { host: "new" } } },
    ]);
    assert.deepEqual(got.config, { endpoint: { host: "new" } });
    assert.deepEqual(got.provenance, { "/endpoint/host": "map" });
  }
});

test("input objects and nested arrays are not mutated or shared with output", () => {
  const nested = { flags: ["a"] };
  const layers = [{ source: "input", values: { nested } }];
  const result = resolveConfiguration(layers);
  assert.deepEqual(nested, { flags: ["a"] });
  result.config.nested.flags.push("changed");
  assert.deepEqual(nested, { flags: ["a"] });
});

test("rejects malformed layers, dangerous keys, cycles, and non-finite numbers without echoing values", () => {
  const cyclic = {}; cyclic.self = cyclic;
  const cases = [
    [null],
    [{ source: " ", values: {} }],
    [{ source: "ok", values: Object.assign(Object.create(null), { constructor: "hidden" }) }],
    [{ source: "ok", values: { bad: Number.POSITIVE_INFINITY } }],
    [{ source: "ok", values: { cyclic } }],
  ];
  for (const layers of cases) {
    assert.throws(() => resolveConfiguration(layers), error => {
      assert.ok(error instanceof TypeError || error instanceof RangeError);
      assert.equal(error.message.includes("hidden"), false);
      return true;
    });
  }
  assert.equal({}.polluted, undefined);
});

test("CLI rejects invalid input without printing submitted values", () => {
  const run = spawnSync(process.execPath, [path.join(root, "src/cli.js")], {
    input: '{"layers":[{"source":"bad","values":{"constructor":"synthetic-sensitive-value"}}]}',
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.length < 200);
  assert.equal(run.stderr.includes("synthetic-sensitive-value"), false);
});
