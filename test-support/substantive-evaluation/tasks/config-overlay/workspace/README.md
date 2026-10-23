# Configuration overlay evaluation

The editable scope is only `src/config-overlay.js`. The CLI, tests, and this
contract are provided as task support. Implement `resolveConfiguration(layers)` in `src/config-overlay.js`. The module
must be dependency-free Node ES modules and export that named function.

Each layer is `{ source, values }`; layers are ordered from lowest to highest
priority. `source` is a non-empty string and `values` is a plain object.
Configuration data consists of own enumerable string-keyed properties, as in
JSON. Symbol and non-enumerable metadata are outside this contract.
Nested plain objects merge recursively. Arrays replace earlier arrays as a
whole. Scalars replace earlier values. An explicit `null` clears that key from
the accumulated result; a later non-null value may add it again. A cleared key
is absent from both output and provenance.

Return `{ config, provenance }`. `provenance` maps JSON Pointer paths to the
source that last supplied each surviving non-object value (including arrays).
Empty objects have no provenance entry. The root pointer is the empty string.
Use RFC 6901 escaping (`~` becomes `~0`, `/` becomes `~1`).

Reject malformed layers and non-JSON values with `TypeError` or `RangeError`.
Reject keys `__proto__`, `prototype`, and `constructor` at every depth to avoid
prototype pollution. Errors must not include supplied configuration values.
Do not mutate layers or their nested values.

`src/cli.js` reads one JSON object `{ layers: [...] }` from stdin and writes the
result as JSON to stdout. On invalid input it writes a concise error to stderr
and exits nonzero. It must call the exported resolver. Do not read process
environment as configuration or access user settings, profiles, or files.

Run the visible suite with `node --test test/visible.test.js`.
