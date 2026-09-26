import { parse, stringify } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';

// This deliberately recognizes only well-known credential forms.  It cannot
// determine whether arbitrary prose or an unfamiliar field contains a secret.
const tokenPattern = /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[\w-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const privateKeyPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const assignmentPattern = /(^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:)\s*)([^\r\n#;]*)/gim;
const headerPattern = /(^\s*(?:authorization|proxy-authorization|x-api-key|cookie)\s*:\s*)([^\r\n]*)/gim;
const bareHeaderValue = /^(?:bearer|basic|token)\s+\S+/i;

function scrubLiteral(value) {
  return value
    .replace(privateKeyPattern, '[REDACTED PRIVATE KEY]')
    .replace(tokenPattern, '[REDACTED]');
}

function scrubString(value) {
  return scrubLiteral(value)
    .replace(headerPattern, '$1[REDACTED]')
    .replace(assignmentPattern, (whole, prefix, key) => keyIsSensitive(key) ? `${prefix}[REDACTED]` : whole);
}

function normalizedName(key) {
  return String(key ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_').toLowerCase();
}
function referenceName(key) {
  const name = normalizedName(key);
  return /^(?:env_key|env_vars|env_http_headers|(?:api_key|access_token|refresh_token|bearer_token|auth_token|client_secret|password)_env(?:_var)?)$/.test(name);
}
function tokenCounterName(name) {
  return /(?:^|_)(?:max_)?tokens?_(?:limit|budget|count)$/.test(name)
    || /^max_tokens?$/.test(name);
}
function keyIsSensitive(key) {
  if (typeof key !== 'string' || referenceName(key)) return false;
  const name = normalizedName(key);
  if (tokenCounterName(name)) return false;
  return /(?:^|_)(?:api_?key|access_?key|secret_?key|client_?secret|private_?key|password|passwd|credentials?|authorization|cookie|secret|token)(?:_(?:value|string|hash))?$/.test(name);
}

/** Return a recursively safe copy of metadata, preserving env reference names. */
export function redactValue(value, key, referenceMap = false, literalHeaderMap = false) {
  const references = referenceMap || referenceName(key);
  const literalHeaders = literalHeaderMap || (!references && /(?:^|_)http_headers$/i.test(key ?? ''));
  if (!references && keyIsSensitive(key)) return '[REDACTED]';
  if (literalHeaders && typeof value === 'string') return '[REDACTED]';
  if (references && typeof value === 'string' && bareHeaderValue.test(value)) return '[REDACTED]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, undefined, references, literalHeaders));
  // Dates and smol-toml's TomlDate are values, not metadata maps.  Keeping
  // their prototype intact avoids rewriting safe TOML merely during inspection.
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result = Object.create(Object.getPrototypeOf(value));
    for (const name of Object.keys(value)) Object.defineProperty(result, name, {
      value: redactValue(value[name], name, references, literalHeaders), enumerable: true, writable: true, configurable: true,
    });
    return result;
  }
  return value;
}

/**
 * Redact known credential material.  Structured files are reserialized only
 * when redaction changed them, so safe input remains byte-for-byte intact.
 */
export function redactText(text, path = '') {
  if (typeof text !== 'string') throw new Error('Content must be text');
  const extension = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === 'json' || extension === 'toml') {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const parseable = bom ? text.slice(1) : text;
    let parsed;
    try { parsed = extension === 'json' ? JSON.parse(parseable) : parse(parseable); }
    catch { throw new Error('Unable to safely redact malformed structured content'); }
    const redacted = redactValue(parsed);
    // Parsed values handle assignment and header keys.  This raw pass is only
    // for comments, which TOML parsing deliberately discards; running the
    // assignment regex here could alter safe env-header references or make
    // regenerated TOML syntactically invalid.
    const raw = scrubLiteral(text);
    if (isDeepStrictEqual(parsed, redacted)) return raw;
    const serialized = extension === 'json'
      ? `${JSON.stringify(redacted, null, 2)}\n`
      : stringify(redacted);
    return bom + serialized;
  }
  return scrubString(text);
}
