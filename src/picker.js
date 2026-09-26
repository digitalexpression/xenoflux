import { createInterface } from 'node:readline';

const display = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0,200);
const when = value => {
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 16) : 'unknown date';
};

/** A small terminal chooser; its callbacks reuse normal inspect/compare paths. */
export async function pickProfile(entries, { input = process.stdin, output = process.stdout,
  inspect, compare, history, signal, actionLabel = 'launch' } = {}) {
  if (!entries.length) { output.write('No profiles. Use xfx profile create NAME --apply.\n'); return null; }
  const menu = () => {
    output.write('\nChoose a profile\n');
    entries.forEach((e, i) => {
      output.write(`${i+1}. ${display(e.name)} [${display(e.state)}]${e.configurationChanged ? ' · native settings changed' : ''}\n`);
      if (e.description) output.write(`   ${display(e.description)}\n`);
      if (e.home) output.write(`   ${display(e.home)}\n`);
    });
    output.write(`Number: ${display(actionLabel)}${inspect ? ' · i NUMBER: inspect' : ''}${compare ? ' · c LEFT RIGHT: compare stored profiles' : ''} · q: cancel\n`);
    if (history) output.write('h: combined history · h NUMBER: profile history · r NUMBER: resume a listed task\n');
    output.write('> ');
  };
  const lines = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const abort = () => lines.close();
  signal?.addEventListener('abort', abort, { once: true });
  lines.on('SIGINT', abort);
  const at = number => /^[1-9]\d*$/.test(number ?? '') ? entries[Number(number)-1] : null;
  let tasks = [];
  menu();
  try {
    if (signal?.aborted) return null;
    for await (const line of lines) {
      const value = line.trim();
      if (value === 'q' || value === 'quit') return null;
      const parts = value.split(/\s+/);
      try {
        if (parts[0] === 'h' && history && (parts.length === 1 || (parts.length === 2 && at(parts[1])))) {
          tasks = [];
          const result = await history(parts.length === 2 ? at(parts[1]).id : undefined);
          tasks = result.entries;
          tasks.forEach((task, i) => output.write(`${i+1}. [${display(task.profileName)}] ${display(task.title)}\n   ${display(task.id)} · ${when(task.updatedAt)} UTC\n`));
          if (!tasks.length) output.write('No saved tasks in this selection.\n');
          if (result.homes.some(h => ['unavailable','partial'].includes(h.status))) output.write('Some profiles could not be read completely; history is incomplete.\n');
          if (result.truncated) output.write('More tasks are available; use history --limit or --search.\n');
          output.write('r NUMBER resumes a task above.\n> '); continue;
        }
        if (parts[0] === 'r' && parts.length === 2 && /^[1-9]\d*$/.test(parts[1])) {
          const task = tasks[Number(parts[1])-1];
          if (task && !task.archived) return { profileId: task.profileId, resumeId: task.id };
          output.write('Show history with h, then choose an available task number.\n> '); continue;
        }
        if (parts.length === 1 && at(value)) {
          const selected = at(value);
          if (selected.state !== 'ready') { output.write('That profile is unavailable.\n> '); continue; }
          return selected.id;
        }
        if (parts[0] === 'i' && parts.length === 2 && at(parts[1]) && inspect) {
          output.write(JSON.stringify(await inspect(at(parts[1]).id), null, 2)+'\n> '); continue;
        }
        if (parts[0] === 'c' && parts.length === 3 && at(parts[1]) && at(parts[2]) && compare) {
          output.write(JSON.stringify(await compare(at(parts[1]).id, at(parts[2]).id), null, 2)+'\n> '); continue;
        }
        output.write('Choose a listed number, i NUMBER, c LEFT RIGHT, h, r NUMBER, or q.\n> ');
      } catch { output.write('That operation could not complete; the stored profiles are unchanged.\n> '); }
    }
    return null;
  } finally { signal?.removeEventListener('abort', abort); lines.close(); }
}
