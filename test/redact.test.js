import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { redactText, redactValue } from '../src/redact.js';

test('redaction preserves safe bytes and removes known credentials while retaining env references', () => {
  const safe = 'title = "ordinary"\n';
  assert.equal(redactText(safe, 'config.toml'), safe);
  const value = redactValue({ env_key: 'OPENAI_API_KEY', api_key: 'sk-123456789012345', env_http_headers: ['AUTH_HEADER'], nested: { token: 'ghp_123456789012345' } });
  assert.equal(value.env_key, 'OPENAI_API_KEY'); assert.equal(value.api_key, '[REDACTED]'); assert.equal(value.nested.token, '[REDACTED]');
  assert.match(redactText('Authorization: Bearer abc\napi_key = "sk-123456789012345"\n', 'notes.txt'), /\[REDACTED\]/);
  assert.doesNotMatch(redactText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'key.pem'), /abc/);
  assert.match(redactText('password = short\n', 'notes.md'), /\[REDACTED\]/);
  assert.equal(redactValue({ env_http_headers: { Authorization: 'TOKEN_ENV' } }).env_http_headers.Authorization, 'TOKEN_ENV');
  assert.equal(redactValue({ env_http_headers: { Authorization: 'Bearer literal-value' } }).env_http_headers.Authorization, '[REDACTED]');
  assert.equal(redactValue({ http_headers: { 'X-Custom': 'literal-header' } }).http_headers['X-Custom'], '[REDACTED]');
  assert.equal(redactValue({ accessToken: 'short' }).accessToken, '[REDACTED]');
});

test('safe structured bytes and TOML dates stay intact while comments are scrubbed', () => {
  const safe = 'second = "two"\nfirst = "one"\ndate = 2026-09-14\n';
  assert.equal(redactText(safe, 'config.toml'), safe);
  const commented = 'name = "safe" # sk-123456789012345\n';
  assert.doesNotMatch(redactText(commented, 'config.toml'), /sk-123456789012345/);
  const reference = '# retained comment\nz = 1\na = 2\ndate = 1979-05-27T07:32:00Z\n[provider.env_http_headers]\nAuthorization = "TOKEN_ENV"\n';
  assert.equal(redactText(reference, 'config.toml'), reference);
});

test('redacted structured TOML remains parseable', () => {
  const output = redactText('[provider]\napi_key = "literal-secret"\n', 'config.toml');
  assert.doesNotThrow(() => parse(output));
  assert.equal(parse(output).provider.api_key, '[REDACTED]');
  const bomToml = redactText('\uFEFFtoken = "short-secret"\n', 'config.toml');
  const bomJson = redactText('\uFEFF{"token":"short-secret"}\n', 'config.json');
  assert.ok(bomToml.startsWith('\uFEFF')); assert.ok(bomJson.startsWith('\uFEFF'));
  assert.equal(parse(bomToml.slice(1)).token, '[REDACTED]');
  assert.equal(JSON.parse(bomJson.slice(1)).token, '[REDACTED]');
});

test('redaction preserves null-prototype tables and treats prototype-like keys as ordinary fields', () => {
  const safe = '[__proto__]\nlabel = "ordinary"\n[constructor]\ndate = 2026-09-26\n';
  assert.equal(redactText(safe, 'config.toml'), safe);
  const parsed = parse(`${safe}token = "private-value"\n`), redacted = redactValue(parsed);
  assert.equal(Object.getPrototypeOf(redacted), null);
  assert.equal(Object.getPrototypeOf(redacted.constructor), null);
  assert.equal(redacted.constructor.token, '[REDACTED]');
  assert.equal(redacted.__proto__.label, 'ordinary');
  const json = JSON.parse('{"__proto__":{"token":"private-value"},"label":"safe"}');
  const cleaned = redactValue(json);
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.equal(Object.hasOwn(cleaned, '__proto__'), true);
  assert.equal(cleaned.__proto__.token, '[REDACTED]');
});

test('token limits and environment reference fields remain usable metadata', () => {
  const safe = `model_auto_compact_token_limit = 120000\nmax_tokens = 4096\ntoken_budget = 256\nbearer_token_env_var = "AUTH_TOKEN_ENV"\napi_key_env = "API_KEY_ENV"\n`;
  assert.equal(redactText(safe, 'config.toml'), safe);
  const value = redactValue({ model_auto_compact_token_limit: 100, max_tokens: 20, token_budget: 3, bearer_token_env_var: 'AUTH_TOKEN_ENV', apiKeyEnv: 'API_KEY_ENV', accessToken: 'literal', password: 42 });
  assert.equal(value.model_auto_compact_token_limit, 100);
  assert.equal(value.max_tokens, 20);
  assert.equal(value.token_budget, 3);
  assert.equal(value.bearer_token_env_var, 'AUTH_TOKEN_ENV');
  assert.equal(value.apiKeyEnv, 'API_KEY_ENV');
  assert.equal(value.accessToken, '[REDACTED]');
  assert.equal(value.password, '[REDACTED]');
  assert.equal(redactValue({ api_key_env: 'sk-123456789012345' }).api_key_env, '[REDACTED]');
  const rawSafe = 'token_budget = 8000\nbearer_token_env_var = SERVICE_TOKEN\n';
  assert.equal(redactText(rawSafe, 'notes.md'), rawSafe);
  assert.match(redactText('token = short-secret\naccessToken = short\nclientSecret = short\n', 'notes.md'), /token = \[REDACTED\][\s\S]*accessToken = \[REDACTED\][\s\S]*clientSecret = \[REDACTED\]/);
  const endpoints = { authorization_endpoint: 'https://example.invalid/authorize', token_endpoint: 'https://example.invalid/token', secret_rotation_interval: 60 };
  assert.equal(redactText(JSON.stringify(endpoints), 'config.json'), JSON.stringify(endpoints));
  const endpointToml = 'authorization_endpoint = "https://example.invalid/authorize"\ntoken_endpoint = "https://example.invalid/token"\nsecret_rotation_interval = 60\n';
  assert.equal(redactText(endpointToml, 'config.toml'), endpointToml);
  assert.equal(redactText('token_endpoint = https://example.invalid/token\n', 'config.txt'), 'token_endpoint = https://example.invalid/token\n');
  assert.deepEqual(redactValue({ github_token: 'short', tokenValue: 'short', secretKey: 'short', client_secret: 'short' }), { github_token: '[REDACTED]', tokenValue: '[REDACTED]', secretKey: '[REDACTED]', client_secret: '[REDACTED]' });
});

test('malformed structured input fails without reflecting its source', () => {
  assert.throws(() => redactText('{"token":"sk-secret', 'x.json'), error => !error.message.includes('sk-secret'));
  assert.throws(() => redactText('token = [', 'x.toml'), /Unable to safely redact/);
});
