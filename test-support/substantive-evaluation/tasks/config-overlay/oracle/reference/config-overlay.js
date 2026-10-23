const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointer(parent, key) {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escaped}`;
}

function validateValue(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("configuration numbers must be finite");
    return;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) throw new TypeError("configuration must not contain cycles");
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) validateValue(item, path, ancestors);
    } else {
      for (const key of Object.keys(value)) {
        if (forbiddenKeys.has(key)) throw new TypeError("configuration contains a forbidden key");
        validateValue(value[key], pointer(path, key), ancestors);
      }
    }
    ancestors.delete(value);
    return;
  }
  throw new TypeError("configuration contains a non-JSON value");
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) result[key] = clone(value[key]);
    return result;
  }
  return value;
}

export function resolveConfiguration(layers) {
  if (!Array.isArray(layers)) throw new TypeError("layers must be an array");
  const config = {};
  const provenance = {};

  for (const layer of layers) {
    if (!isPlainObject(layer) || typeof layer.source !== "string" || layer.source.trim() === "" || !isPlainObject(layer.values)) {
      throw new TypeError("each layer needs a non-empty source and plain-object values");
    }
    validateValue(layer.values, "", new Set());
    const source = layer.source;

    function apply(target, incoming, parentPath) {
      for (const key of Object.keys(incoming)) {
        if (forbiddenKeys.has(key)) throw new TypeError("configuration contains a forbidden key");
        const path = pointer(parentPath, key);
        const value = incoming[key];
        if (value === null) {
          delete target[key];
          for (const knownPath of Object.keys(provenance)) {
            if (knownPath === path || knownPath.startsWith(`${path}/`)) delete provenance[knownPath];
          }
        } else if (isPlainObject(value)) {
          if (!isPlainObject(target[key])) target[key] = {};
          delete provenance[path];
          apply(target[key], value, path);
        } else {
          target[key] = clone(value);
          for (const knownPath of Object.keys(provenance)) {
            if (knownPath.startsWith(`${path}/`)) delete provenance[knownPath];
          }
          provenance[path] = source;
        }
      }
    }
    apply(config, layer.values, "");
  }
  return { config, provenance };
}
