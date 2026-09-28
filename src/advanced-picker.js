import { StringDecoder } from 'node:string_decoder';

const clean = (value, limit = 240) => String(value ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, limit);
const bounded = (value, limit) => {
  const text = clean(value, Number.MAX_SAFE_INTEGER);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 14))}… [truncated]` : text;
};

function itemSearchText(item) {
  return [item.label, item.category, item.scope, item.origin, item.path, item.reason]
    .map(value => String(value ?? '').toLowerCase()).join(' ');
}

function makeRows(inventory, expanded, query) {
  const categories = new Map();
  for (const item of inventory.items ?? []) {
    const category = clean(item.category, 100) || 'Other';
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(item);
  }
  const rows = [];
  for (const [category, items] of categories) {
    const categoryMatches = query && category.toLowerCase().includes(query);
    const matches = query ? items.filter(item => categoryMatches || itemSearchText(item).includes(query)) : items;
    if (query && !matches.length && !categoryMatches) continue;
    rows.push({ type: 'category', category, label: category, expanded: query ? true : expanded.has(category), count: items.length });
    if (query ? true : expanded.has(category)) {
      for (const item of matches) rows.push({ type: 'item', category, item, label: clean(item.label || item.id) });
    }
  }
  return rows;
}

function formatChange(change) {
  if (typeof change === 'string') return clean(change, 500);
  if (change && typeof change === 'object' && ('before' in change || 'after' in change)) {
    const parts = [];
    for (const key of ['path', 'action']) if (change[key] != null) parts.push(`${key}: ${clean(change[key], 160)}`);
    if ('before' in change) parts.push(`before: ${bounded(change.before, 220)}`);
    if ('after' in change) parts.push(`after: ${bounded(change.after, 220)}`);
    for (const key of ['beforeHash', 'afterHash', 'hash', 'beforeSize', 'afterSize', 'size']) {
      if (change[key] != null) parts.push(`${key}: ${clean(change[key], 100)}`);
    }
    return parts.join('; ');
  }
  if (change && typeof change === 'object') {
    const parts = [];
    for (const key of ['path', 'action', 'status', 'hash', 'beforeHash', 'afterHash', 'size', 'beforeSize', 'afterSize'])
      if (change[key] != null) parts.push(`${key}: ${clean(change[key], 160)}`);
    if (parts.length) return parts.join('; ');
    return 'Change details are available in the final copy report.';
  }
  return clean(change, 500);
}

function previewLines(preview) {
  const entries = Array.isArray(preview) ? preview : preview?.items;
  if (!Array.isArray(entries)) return ['Preview is ready.'];
  const lines = ['Preview:'];
  for (const entry of entries) {
    lines.push(`  ${clean(entry.label || entry.id, 120)} — ${clean(entry.status || 'planned', 80)}`);
    const changes = entry.changes;
    if (Array.isArray(changes)) for (const change of changes) lines.push(`    ${formatChange(change)}`);
    else if (changes != null) lines.push(`    ${formatChange(changes)}`);
  }
  if (lines.length > 2000) return [...lines.slice(0, 1999), '  … preview truncated; use the final copy report for the complete list.'];
  return lines;
}

/**
 * Search and select copyable inventory items. This picker only returns IDs;
 * it never performs the copy operation.
 */
export async function pickAdvancedItems(inventory, { input = process.stdin, output = process.stdout, signal, review } = {}) {
  if (!inventory || !Array.isArray(inventory.items)) throw new Error('Invalid advanced picker inventory');
  const items = inventory.items.filter(item => item && typeof item.id === 'string' && item.id);
  const expanded = new Set(items.map(item => clean(item.category, 100) || 'Other'));
  const selected = new Set();
  const isTTY = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  const previousRaw = input.isRaw;
  const previousFlowing = input.readableFlowing;
  const decoder = new StringDecoder('utf8');
  let query = '';
  let searching = false;
  let cursor = 0;
  let keyBuffer = '';
  let escapeTimer;
  let closed = false;
  let busy = false;
  let result = null;
  let previewLinesCache = [];
  let previewPage = 0;
  let resolveResult;
  const done = new Promise(resolve => { resolveResult = resolve; });

  const rowsNow = () => makeRows({ items }, expanded, query.toLowerCase());
  const writeLines = lines => {
    if (isTTY) output.write('\x1b[2J\x1b[H');
    else output.write('\n--- Advanced profile picker ---\n');
    const width = Math.max(20, Math.min(200, Number(output.columns) || 80));
    for (const line of lines) output.write(`${line.length > width ? `${line.slice(0, width - 1)}…` : line}\n`);
  };
  const draw = () => {
    const rows = rowsNow();
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
    const maxRows = Math.max(6, Math.min(18, (output.rows || 24) - 6));
    let start = Math.max(0, cursor - Math.floor(maxRows / 2));
    start = Math.min(start, Math.max(0, rows.length - maxRows));
    const lines = [
      'Search: ' + (searching ? `${query}▌` : (query || '(press / to search)')),
      `Use arrows to navigate, right/left to expand, space to select, Enter ${review ? 'to preview then continue' : 'to continue'}, d for details, q to cancel.`,
      `Selected: ${selected.size}`,
    ];
    for (let i = start; i < Math.min(rows.length, start + maxRows); i++) {
      const row = rows[i], marker = i === cursor ? '>' : ' ';
      if (row.type === 'category') lines.push(`${marker} ${row.expanded ? '▾' : '▸'} ${clean(row.category, 100)} (${row.count})`);
      else {
        const item = row.item;
        const checkbox = selected.has(item.id) ? '[x]' : '[ ]';
        const eligible = item.copyable === true;
        const suffix = eligible ? '' : ` — unavailable${item.reason ? `: ${clean(item.reason, 100)}` : ''}`;
        lines.push(`${marker} ${checkbox} ${clean(item.label || item.id, 140)}${suffix}`);
      }
    }
    if (start > 0) lines.push('  …');
    lines.push('');
    writeLines(lines);
  };
  const finish = value => {
    if (closed) return;
    closed = true;
    result = value;
    resolveResult(result);
  };
  const drawPreview = () => {
    const pageSize = Math.max(1, Math.min(16, (Number(output.rows) || 24) - 6));
    const pageCount = Math.max(1, Math.ceil(previewLinesCache.length / pageSize));
    previewPage = Math.max(0, Math.min(pageCount - 1, previewPage));
    const start = previewPage * pageSize;
    writeLines([
      `Preview page ${previewPage + 1}/${pageCount} (${previewLinesCache.length} lines). Up/down or space pages; another key returns.`,
      ...previewLinesCache.slice(start, start + pageSize),
    ]);
  };
  const showPreview = async (idList, prefix = []) => {
    if (typeof review !== 'function') return;
    if (busy) return;
    busy = true;
    try {
      const preview = await review(idList);
      if (closed) return;
      previewLinesCache = [...prefix, ...previewLines(preview)];
      previewPage = 0;
      drawPreview();
    } catch (error) {
      if (closed) return;
      previewLinesCache = [`Could not build preview: ${clean(error?.message || error, 240)}`];
      previewPage = 0;
      drawPreview();
    } finally {
      busy = false;
      if (!closed) waitingPreview = true;
    }
  };
  const showItemDetails = async item => {
    const details = [
      `Details: ${clean(item.label || item.id, 120)}`,
      `Category: ${clean(item.category || 'Other', 120)}`,
      `Availability: ${item.copyable === true ? 'available to copy' : `unavailable${item.reason ? ` — ${clean(item.reason, 220)}` : ''}`}`,
    ];
    for (const key of ['scope', 'origin', 'path']) if (item[key] != null) details.push(`${key}: ${clean(item[key], 220)}`);
    if (item.copyable === true && review) await showPreview([item.id], details.concat(['']));
    else {
      previewLinesCache = details;
      previewPage = 0;
      drawPreview();
      waitingPreview = true;
    }
  };
  let waitingPreview = false;

  const onKey = async key => {
    if (closed) return;
    if (key === '\u0003') { finish(null); return; }
    if (busy) return;
    if (waitingPreview) {
      if (key === '\u001b[B' || key === ' ') { previewPage++; drawPreview(); return; }
      if (key === '\u001b[A') { previewPage--; drawPreview(); return; }
      waitingPreview = false; draw(); return;
    }
    if (key === '\u001b') {
      if (searching) searching = false;
      else finish(null);
      draw(); return;
    }
    if (key === '\u001b[A' || key === '\u001b[B') {
      const rows = rowsNow();
      cursor = Math.max(0, Math.min(rows.length - 1, cursor + (key.endsWith('A') ? -1 : 1)));
      draw(); return;
    }
    if (key === '\u001b[C' || key === '\u001b[D') {
      const row = rowsNow()[cursor];
      if (row?.type === 'category') {
        if (key.endsWith('C')) expanded.add(row.category); else expanded.delete(row.category);
      } else if (key.endsWith('D')) {
        const categoryRow = rowsNow().findIndex(candidate => candidate.type === 'category' && candidate.category === row?.category);
        if (categoryRow >= 0) cursor = categoryRow;
      }
      draw(); return;
    }
    if (searching) {
      if (key === '\u007f' || key === '\b') query = query.slice(0, -1);
      else if (key === '\r' || key === '\n') searching = false;
      else if (key.length === 1 && key >= ' ') query += key;
      cursor = 0; draw(); return;
    }
    if (key === 'q' || key === 'Q') { finish(null); return; }
    if (key === '/') { searching = true; draw(); return; }
    if (key === 'd' || key === 'D') {
      const row = rowsNow()[cursor];
      if (row?.type === 'item') await showItemDetails(row.item);
      else await showPreview([...selected]);
      return;
    }
    if (key === ' ') {
      const row = rowsNow()[cursor];
      if (row?.type === 'item' && row.item.copyable === true) {
        if (selected.has(row.item.id)) selected.delete(row.item.id); else selected.add(row.item.id);
      } else if (row?.type === 'category') {
        if (expanded.has(row.category)) expanded.delete(row.category); else expanded.add(row.category);
      }
      draw(); return;
    }
    if (key === '\r' || key === '\n') {
      const row = rowsNow()[cursor];
      if (row?.type === 'category') {
        expanded.has(row.category) ? expanded.delete(row.category) : expanded.add(row.category);
        draw(); return;
      }
      if (!selected.size) { writeLines(['Select at least one available item, or press q to cancel.']); return; }
      const ids = items.filter(item => selected.has(item.id)).map(item => item.id);
      if (review) await showPreview(ids);
      finish(ids);
    }
  };
  const consume = chunk => {
    keyBuffer += decoder.write(chunk);
    while (keyBuffer) {
      if (keyBuffer[0] === '\u001b') {
        if (keyBuffer.length === 1) {
          clearTimeout(escapeTimer);
          escapeTimer = setTimeout(() => { keyBuffer = keyBuffer.slice(1); void onKey('\u001b'); }, 40);
          return;
        }
        clearTimeout(escapeTimer);
        if (keyBuffer[1] === '[') {
          if (keyBuffer.length < 3) return;
          const sequence = keyBuffer.slice(0, 3);
          keyBuffer = keyBuffer.slice(3);
          void onKey(sequence);
          continue;
        }
        keyBuffer = keyBuffer.slice(1);
        void onKey('\u001b');
        continue;
      }
      const key = String.fromCodePoint(keyBuffer.codePointAt(0));
      keyBuffer = keyBuffer.slice(key.length);
      void onKey(key);
    }
  };
  const onEnd = () => finish(null);
  const onAbort = () => finish(null);
  const onSigint = () => finish(null);

  if (signal?.aborted) return null;
  if (isTTY) input.setRawMode(true);
  input.on('data', consume);
  input.once('end', onEnd);
  input.once('close', onEnd);
  input.on('SIGINT', onSigint);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    draw();
    return await done;
  } finally {
    clearTimeout(escapeTimer);
    input.off('data', consume);
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.off('SIGINT', onSigint);
    signal?.removeEventListener('abort', onAbort);
    if (isTTY) input.setRawMode(Boolean(previousRaw));
    if (previousFlowing !== true) input.pause();
  }
}
