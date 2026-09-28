import { homedir } from 'node:os';
import { inspectProfile } from './profile-inventory.js';
import { pickAdvancedItems } from './advanced-picker.js';
import { planCopy, validateAdvancedSelection } from './native-copy.js';
import { confirmCopyAction } from './copy-picker.js';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** Each conflicting item needs an explicit replacement choice; otherwise keep it. */
export async function reviewAdvancedConflicts(preview, selection, io = {}) {
  const output = io.output ?? process.stdout;
  const chosen = new Set(selection);
  for (const item of preview.items ?? []) {
    if (item.status !== 'conflict' || !chosen.has(item.id)) continue;
    if (io.signal?.aborted) return null;
    output.write(`\nConflict: ${clean(item.label)}\n`);
    output.write(`${JSON.stringify(item.changes ?? [], null, 2).replace(/[\x7f-\x9f]/g, ' ')}\n`);
    output.write('Replace this selected item, or keep the destination by entering anything else.\n');
    if (!await confirmCopyAction('replace', io)) chosen.delete(item.id);
    if (io.signal?.aborted) return null;
  }
  return selection.filter(id => chosen.has(id));
}

/** Read-only selection, shared by creation and copying. Never creates a profile. */
export async function selectAdvancedCopy(store, source, target, {
  input = process.stdin, output = process.stdout, signal, defaultUserHome = homedir(),
} = {}) {
  const controller = signal ? null : new AbortController();
  signal ??= controller.signal;
  const abort = () => controller?.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
  if (controller) for (const name of signals) process.on(name, abort);
  const io = { input, output, signal };
  try {
    if (!input.isTTY || !output.isTTY) throw new Error('Advanced selection requires an interactive terminal; use profile inspect NAME --json for inventory');
    const inventory = await inspectProfile(store, source, { defaultUserHome });
    const review = selection => target
      ? planCopy(store, source, target, { selection, defaultUserHome })
      : validateAdvancedSelection(store, source, selection, { defaultUserHome });
    let selection = await pickAdvancedItems(inventory, { ...io, review });
    if (!selection?.length || signal?.aborted) return null;
    await validateAdvancedSelection(store, source, selection, { defaultUserHome });
    if (target) selection = await reviewAdvancedConflicts(await review(selection), selection, io);
    return selection?.length ? selection : null;
  } finally { if (controller) for (const name of signals) process.off(name, abort); }
}
