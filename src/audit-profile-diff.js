const MAX_HUNKS = 256;

/** Comparison projection for audit profile resources. Keeps only discovered,
 * redacted fields and never includes filesystem paths or raw observations. */
export function comparableAuditResource(resource = {}) {
  return {
    status: resource.status ?? 'unknown',
    value: resource.value ?? null,
    fingerprint: resource.fingerprint ?? null,
    version: resource.version ?? null,
    comparison: resource.comparison ?? null,
    valueStatus: resource.valueStatus ?? null,
    state: resource.state ?? null,
    detail: resource.detail ? safeDetail(resource.detail) : null,
  };
}

function safeDetail(detail) {
  const safe = { status: detail.status ?? 'unknown' };
  if (typeof detail.text === 'string') safe.text = detail.text;
  if (Array.isArray(detail.files)) safe.files = detail.files.map(file => ({
    path: file.path,
    status: file.status ?? 'unknown',
    fingerprint: file.fingerprint ?? null,
    ...(typeof file.content === 'string' ? { content: file.content } : {}),
    ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {}),
    ...(Number.isFinite(file.mode) ? { mode: file.mode & 0o777 } : {}),
    ...(file.truncated === true ? { truncated: true } : {}),
  })).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (detail.coverage) safe.coverage = { ...detail.coverage };
  if (detail.truncated === true) safe.truncated = true;
  return safe;
}

function diffText(path, left, right) {
  if (left === right) return [];
  const a = left.split('\n'), b = right.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return [{ path, kind: 'changed', left: a.slice(prefix, a.length - suffix), right: b.slice(prefix, b.length - suffix),
    leftStart: prefix + 1, rightStart: prefix + 1 }];
}

function valueDiff(path, left, right, output, allowPresenceDiff = true) {
  if (Object.is(left, right)) return;
  if (left && right && typeof left === 'object' && typeof right === 'object'
    && !Array.isArray(left) && !Array.isArray(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!Object.hasOwn(left, key)) output.push(allowPresenceDiff
        ? { path: `${path}.${key}`, kind: 'added', right: right[key] }
        : { path: `${path}.${key}`, kind: 'unknown', reason: 'A safe field is visible on one side, but the other side has incomplete definition coverage.' });
      else if (!Object.hasOwn(right, key)) output.push(allowPresenceDiff
        ? { path: `${path}.${key}`, kind: 'removed', left: left[key] }
        : { path: `${path}.${key}`, kind: 'unknown', reason: 'A safe field is visible on one side, but the other side has incomplete definition coverage.' });
      else valueDiff(`${path}.${key}`, left[key], right[key], output, allowPresenceDiff);
    }
    return;
  }
  output.push({ path, kind: 'changed', left, right });
}

/** Create a bounded human-readable diff from safe discovery details. */
export function compareAuditResourceDetails(left = {}, right = {}) {
  const a = safeDetail(left.detail ?? {}), b = safeDetail(right.detail ?? {});
  const hasValue = left.value !== undefined || right.value !== undefined;
  if (!left.detail && !right.detail && !hasValue) return { status: 'unavailable', hunks: [], coverage: 'unavailable' };
  const hunks = [];
  let partial = Boolean(left.detail || right.detail)
    && [a.status, b.status].some(status => !['available', 'complete'].includes(status));
  if (typeof a.text === 'string' && typeof b.text === 'string') hunks.push(...diffText('content', a.text, b.text));
  else if (a.text !== undefined || b.text !== undefined) partial = true;

  const leftFiles = new Map((a.files ?? []).map(file => [file.path, file]));
  const rightFiles = new Map((b.files ?? []).map(file => [file.path, file]));
  for (const path of [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort()) {
    if (hunks.length >= MAX_HUNKS) { partial = true; break; }
    const l = leftFiles.get(path), r = rightFiles.get(path);
    if (!l) {
      if (a.status === 'available' && r.status === 'available' && typeof r.content === 'string') hunks.push({ path, kind: 'added', right: r.content.split('\n') });
      else { hunks.push({ path, kind: 'unknown', reason: 'Right package file is present but its readable content is unavailable.' }); partial = true; }
    } else if (!r) {
      if (b.status === 'available' && l.status === 'available' && typeof l.content === 'string') hunks.push({ path, kind: 'removed', left: l.content.split('\n') });
      else { hunks.push({ path, kind: 'unknown', reason: 'Left package file is present but its readable content is unavailable.' }); partial = true; }
    } else if (typeof l.content === 'string' && typeof r.content === 'string') {
      // A redacted/truncated observation may still contain useful safe lines.
      // Show the observed hunk while the resource-level partial status keeps
      // omitted portions from being treated as a complete comparison.
      hunks.push(...diffText(path, l.content, r.content));
      if (l.status !== 'available' || r.status !== 'available') partial = true;
      if (Number.isFinite(l.mode) && Number.isFinite(r.mode) && l.mode !== r.mode)
        hunks.push({ path, kind: 'metadata-changed', left: { mode: l.mode }, right: { mode: r.mode } });
    } else if (l.status !== 'available' || r.status !== 'available') {
      if (l.fingerprint !== r.fingerprint || l.status !== r.status) {
        hunks.push({ path, kind: 'unknown', reason: 'A package file differs or has unresolved coverage; its contents cannot be compared.' }); partial = true;
      }
    } else {
      if (l.fingerprint !== r.fingerprint) {
        hunks.push({ path, kind: 'unknown', reason: 'A package file fingerprint differs, but readable content is unavailable.' }); partial = true;
      }
      if (Number.isFinite(l.mode) && Number.isFinite(r.mode) && l.mode !== r.mode)
        hunks.push({ path, kind: 'metadata-changed', left: { mode: l.mode }, right: { mode: r.mode } });
    }
  }

  if (left.value !== undefined || right.value !== undefined) {
    const incomplete = left.comparison === 'partial' || right.comparison === 'partial'
      || left.valueStatus === 'partial' || right.valueStatus === 'partial';
    if (left.valueStatus === 'omitted' || right.valueStatus === 'omitted'
      || !['available', 'partial'].includes(left.comparison) || !['available', 'partial'].includes(right.comparison)) partial = true;
    else {
      if (incomplete) partial = true;
      if (left.value === undefined || right.value === undefined) {
        hunks.push({ path: 'value', kind: incomplete ? 'unknown' : left.value === undefined ? 'added' : 'removed',
          ...(left.value !== undefined ? { left: left.value } : {}), ...(right.value !== undefined ? { right: right.value } : {}),
          ...(incomplete ? { reason: 'One side has incomplete safe-value coverage.' } : {}) });
      } else valueDiff('value', left.value, right.value, hunks, !incomplete);
    }
  }
  if (a.status === 'redacted' || b.status === 'redacted') partial = true;
  return { status: partial ? (hunks.length ? 'partial' : 'unknown') : 'available', hunks: hunks.slice(0, MAX_HUNKS),
    coverage: partial ? 'partial' : 'complete' };
}
