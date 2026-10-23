// TODO: implement the layered configuration contract in README.md.
export function resolveConfiguration(layers) {
  if (!Array.isArray(layers)) throw new TypeError("layers must be an array");
  return { config: {}, provenance: {} };
}
