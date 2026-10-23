// Extract a small, safe vocabulary of actions from retained native command
// evidence. This module recognizes literal syntax only; it never evaluates it.
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

const MAX_COMMAND = 32 * 1024;
const MAX_SCRIPT = 16 * 1024;
export const AUDIT_ACTION_KINDS = Object.freeze(['read', 'edit', 'visible-test', 'inline-assertion']);
export const AUDIT_ACTION_NAMES = Object.freeze(['read-files', 'edit-files', 'run-test-file', 'inline-assertion']);
export const AUDIT_ACTION_SUBJECTS = Object.freeze(['maximum-safe-integer', 'null-input', 'array-input', 'symbol-input']);
export const AUDIT_ACTION_RESULT_SCOPES = Object.freeze(['action', 'invocation']);

export function isNamedAuditAction(value) {
  const expectedName = ({ read: 'read-files', edit: 'edit-files', 'visible-test': 'run-test-file', 'inline-assertion': 'inline-assertion' })[value?.kind];
  return Boolean(value && expectedName && value.name === expectedName
    && Array.isArray(value.targets) && value.targets.every(target => typeof target === 'string' && !isAbsolute(target)
      && !target.split('/').includes('..')) && Array.isArray(value.subjects)
    && value.subjects.every(subject => AUDIT_ACTION_SUBJECTS.includes(subject))
    && (value.kind === 'inline-assertion' || value.subjects.length === 0)
    && (value.agentId === null || typeof value.agentId === 'string')
    && (value.turnId === null || typeof value.turnId === 'string')
    && (value.callId === null || typeof value.callId === 'string')
    && (value.sourceLine === null || Number.isSafeInteger(value.sourceLine))
    && (value.resultSourceLine === null || Number.isSafeInteger(value.resultSourceLine))
    && (value.resultIndex === null || Number.isSafeInteger(value.resultIndex))
    && AUDIT_ACTION_RESULT_SCOPES.includes(value.resultScope)
    && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && (value.sourceFingerprint === null || /^[a-f0-9]{64}$/.test(value.sourceFingerprint)));
}

function literalJson(source, start) {
  // Find one JSON string without interpreting JavaScript escapes beyond JSON.
  if (source[start] !== '"') return null;
  let escaped = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (!escaped && ch === '"') {
      try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; } catch { return null; }
    }
    if (!escaped && ch === '\\') escaped = true; else escaped = false;
  }
  return null;
}

function safeRelative(path, repoRoot) {
  if (typeof path !== 'string' || !path || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)) return null;
  if (isAbsolute(path)) {
    const target = resolve(path), rel = relative(resolve(repoRoot), target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  }
  const clean = normalize(path);
  if (clean === '.' || clean === '..' || clean.startsWith(`..${sep}`)) return null;
  return clean.split(sep).join('/');
}

function parseLiteralCalls(input) {
  if (typeof input !== 'string' || input.length > MAX_COMMAND) return null;
  const calls = []; let i = 0;
  const ws = () => { while (/\s/.test(input[i] ?? '')) i++; };
  const eat = token => { ws(); if (!input.startsWith(token, i)) return false; i += token.length; return true; };
  while (true) {
    ws(); if (i === input.length) return calls.length ? calls : null;
    if (!eat('text(await tools.')) return null;
    let method;
    if (eat('exec_command')) method = 'exec'; else if (eat('apply_patch')) method = 'patch'; else return null;
    if (!eat('(')) return null;
    let value;
    if (method === 'patch') {
      value = literalJson(input, (ws(), i));
      if (!value || typeof value.value !== 'string') return null;
      i = value.end;
    } else {
      if (!eat('{')) return null;
      const fields = Object.create(null);
      while (true) {
        ws(); if (eat('}')) break;
        let key;
        if (input[i] === '"') {
          const keyLiteral = literalJson(input, i);
          if (!keyLiteral || typeof keyLiteral.value !== 'string') return null;
          key = keyLiteral.value; i = keyLiteral.end;
        } else {
          const keyMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
          if (!keyMatch) return null;
          key = keyMatch[0]; i += key.length;
        }
        if (!eat(':') || !['cmd', 'workdir', 'max_output_tokens', 'yield_time_ms', 'tty', 'login'].includes(key)) return null;
        ws(); let field;
        if (input[i] === '"') field = literalJson(input, i);
        else {
          const primitive = /^(?:-?\d+(?:\.\d+)?|true|false)/.exec(input.slice(i));
          if (primitive) {
            let parsed; try { parsed = JSON.parse(primitive[0]); } catch { return null; }
            field = { value: parsed, end: i + primitive[0].length };
          }
        }
        if (!field || Object.hasOwn(fields, key)) return null;
        fields[key] = field.value; i = field.end;
        ws(); if (eat('}')) break;
        if (!eat(',')) return null;
      }
      if (typeof fields.cmd !== 'string' || Object.entries(fields).some(([key, v]) => key === 'workdir' ? typeof v !== 'string'
        : key === 'tty' || key === 'login' ? typeof v !== 'boolean' : key === 'cmd' ? false : !Number.isSafeInteger(v) || v < 0)) return null;
      value = { command: fields.cmd, workdir: fields.workdir ?? null };
    }
    if (!eat(')') || !eat(')') || !eat(';')) return null;
    calls.push(method === 'patch' ? { method, patch: value.value } : { method, ...value });
    if (calls.length > 100) return null;
  }
}

export function countLiteralActionCalls(input) {
  return parseLiteralCalls(input)?.length ?? null;
}

function patchAction(patch, repoRoot) {
  if (typeof patch !== 'string' || patch.length > MAX_SCRIPT || !patch.startsWith('*** Begin Patch\n') || !patch.endsWith('\n*** End Patch')) return null;
  const paths = [];
  for (const row of patch.split(/\r?\n/)) {
    const found = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(row);
    if (!found) continue;
    const path = safeRelative(found[1], repoRoot);
    if (!path) return null;
    paths.push(path);
  }
  return paths.length ? { kind: 'edit', name: 'edit-files', targets: [...new Set(paths)], subjects: [], resultScope: 'invocation' } : null;
}

function literalCatSequence(command, repoRoot) {
  if (typeof command !== 'string' || command.length > MAX_COMMAND || /[;&|<>$`()\\#~*?\[\]{}]/.test(command)) return null;
  const rows = command.split(/\r?\n/).map(row => row.trim()).filter(Boolean), targets = [];
  if (!rows.length) return null;
  for (const row of rows) {
    const words = shellWords(row);
    if (!words || words[0] !== 'cat' || words.length < 2) return null;
    const paths = words.slice(1).map(path => safeRelative(path, repoRoot));
    if (!paths.length || paths.some(path => !path)) return null;
    targets.push(...paths);
  }
  return { kind: 'read', name: 'read-files', targets: [...new Set(targets)], subjects: [],
    resultScope: rows.length > 1 ? 'invocation' : 'action' };
}

function shellWords(text) {
  if (typeof text !== 'string' || text.length > MAX_COMMAND || /[;&|<>$`()\\\n\r#~*?\[\]{}]/.test(text)) return null;
  const out = []; let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '')) i++;
    if (i >= text.length) break;
    const q = text[i] === '"' || text[i] === "'" ? text[i++] : null;
    const start = i;
    while (i < text.length && (q ? text[i] !== q : !/\s/.test(text[i]))) i++;
    if (q && text[i] !== q) return null;
    const word = text.slice(start, i);
    if (!word || (!q && /['"]/.test(word))) return null;
    out.push(word); if (q) i++;
  }
  return out;
}

function codeTokens(source) {
  const tokens = []; let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { i += 2; while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++; let escaped = false;
      while (i < source.length) { const current = source[i++]; if (!escaped && current === quote) break;
        if (!escaped && current === '\\') escaped = true; else escaped = false; }
      tokens.push({ type: 'string' }); continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    if (identifier) { tokens.push({ type: 'id', value: identifier[0] }); i += identifier[0].length; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(source.slice(i));
    if (number) { tokens.push({ type: 'number', value: number[0] }); i += number[0].length; continue; }
    tokens.push({ type: 'punct', value: ch }); i++;
  }
  return tokens;
}

function assertionEvidence(script) {
  const tokens = codeTokens(script), subjects = new Set(); let assertions = 0;
  const pair = (a, b) => a?.value === b;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (!(tokens[i].value === 'assert' && pair(tokens[i + 1], '.') && tokens[i + 2]?.type === 'id')) continue;
    let open = i + 3; while (tokens[open]?.value !== '(' && open < tokens.length) open++;
    if (open >= tokens.length) continue;
    assertions++;
    let depth = 0, end = open;
    for (; end < tokens.length; end++) { if (tokens[end].value === '(') depth++; else if (tokens[end].value === ')' && --depth === 0) break; }
    if (end >= tokens.length) continue;
    i = end;
  }
  // Subjects describe literal constructs present in a script that invokes an
  // assertion API; they do not claim that a branch executed or an assertion passed.
  if (assertions) for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === 'Number' && pair(tokens[i + 1], '.') && pair(tokens[i + 2], 'MAX_SAFE_INTEGER'))
      subjects.add('maximum-safe-integer');
    if (tokens[i].value === 'null') subjects.add('null-input');
    if (tokens[i].value === '[' && tokens[i + 1]?.value === ']') subjects.add('array-input');
    if (tokens[i].value === 'Symbol' && tokens[i + 1]?.value === '(') subjects.add('symbol-input');
  }
  return { assertions, subjects: [...subjects] };
}

function heredocScript(command) {
  const match = /^node(?:\s+--input-type=(?:module|commonjs))?\s+<<\s*(['"]?)([A-Z_][A-Z0-9_]*)\1\r?\n([\s\S]*?)\r?\n\2\s*$/.exec(command);
  return match && match[3].length <= MAX_SCRIPT ? match[3] : null;
}

function classify(command, repoRoot, recordedCwd) {
  if (typeof command !== 'string' && (!Array.isArray(command) || command.some(x => typeof x !== 'string'))) return null;
  if (typeof command === 'string') {
    const catSequence = literalCatSequence(command, repoRoot);
    if (catSequence) return catSequence;
  }
  let words;
  if (typeof command === 'string') words = shellWords(command);
  else if (command.length === 2 && ['/bin/cat', '/usr/bin/cat', 'cat'].includes(command[0])) words = ['cat', command[1]];
  else if (command.length === 3 && ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(command[0])
    && ['-c', '-lc'].includes(command[1])) words = shellWords(command[2]);
  else words = shellWords(command.join(' '));
  if (!words?.length && typeof command === 'string') {
    const script = heredocScript(command), evidence = script ? assertionEvidence(script) : null;
    if (evidence?.assertions) return { kind: 'inline-assertion', name: 'inline-assertion', targets: [], subjects: evidence.subjects, resultScope: 'invocation' };
  }
  if (!words?.length) return null;
  if (['cat', '/bin/cat', '/usr/bin/cat'].includes(words[0]) && words.length >= 2) {
    const targets = words.slice(1).map(p => safeRelative(p, repoRoot));
    if (!targets.length || targets.some(p => !p)) return null;
    return { kind: 'read', name: 'read-files', targets, subjects: [], resultScope: 'action' };
  }
  if (words[0] === 'node' && words.includes('--test') && words.length === 3 && words[2].startsWith('test/')) {
    const target = safeRelative(words[2], repoRoot);
    return target ? { kind: 'visible-test', name: 'run-test-file', targets: [target], subjects: [], resultScope: 'action' } : null;
  }
  return null;
}

export function extractNamedActions(records, { repoRoot, sourceFingerprint = null } = {}) {
  if (!Array.isArray(records) || typeof repoRoot !== 'string') return [];
  const actions = [];
  for (const record of records.slice(0, 10000)) {
    const p = record?.payload ?? {};
    const turnId = p.turn_id ?? p.turnId ?? null;
    const item = p.item && typeof p.item === 'object' ? p.item : p;
    const responseType = record?.type === 'response_item' ? (item.type ?? p.type) : null;
    const wrappedResponseCall = responseType === 'custom_tool_call';
    if (!(wrappedResponseCall || record?.type === 'event_msg' && ['item_completed', 'exec_command_end'].includes(p.type))) continue;
    let action = null;
    if ((p.type === 'item_completed' || wrappedResponseCall) && /^custom_tool_call$/i.test(item.type ?? responseType ?? '')
      && item.name === 'exec') {
      const input = typeof item.input === 'string' ? item.input : '';
      const calls = parseLiteralCalls(input);
      if (!calls) continue;
      for (let invocationIndex = 0; invocationIndex < calls.length; invocationIndex++) {
        const call = calls[invocationIndex];
        action = call.method === 'patch' ? patchAction(call.patch, repoRoot)
          : call.workdir && resolve(call.workdir) !== resolve(repoRoot) ? null : classify(call.command, repoRoot, call.workdir);
        if (!action) continue;
        actions.push({ ...action, agentId: p.agent_id ?? null, turnId,
          callId: item.call_id ?? item.id ?? null, sourceLine: record.sourceLine ?? null,
          resultSourceLine: null, resultIndex: null, exitCode: null, invocationIndex, sourceFingerprint });
      }
      continue;
    } else {
      if (p.type === 'item_completed' && !/^CommandExecution$/i.test(item.type ?? '')) continue;
      const command = Array.isArray(item.command) ? item.command : null;
      const recordedCwd = typeof item.cwd === 'string' ? item.cwd : null;
      if (recordedCwd && resolve(recordedCwd) !== resolve(repoRoot)) continue;
      if (!recordedCwd) continue;
      action = classify(command, repoRoot, recordedCwd);
    }
    if (!action) continue;
    const exitCode = item.exit_code;
    actions.push({ ...action, agentId: p.agent_id ?? null, turnId,
      callId: item.call_id ?? item.id ?? null, sourceLine: record.sourceLine ?? null,
      resultSourceLine: record.sourceLine ?? null, resultIndex: null,
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : null, sourceFingerprint });
  }
  return actions;
}

export function unambiguousExitCode(response) {
  return response && typeof response === 'object' && !Array.isArray(response)
    && Object.keys(response).filter(key => key === 'exit_code').length === 1
    && Number.isSafeInteger(response.exit_code) ? response.exit_code : null;
}
