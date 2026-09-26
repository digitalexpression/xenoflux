import { createInterface } from 'node:readline';

const display = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
const descriptions = {
  config: 'general model, reasoning and permission settings',
  instructions: 'global AGENTS.md and AGENTS.override.md',
  agents: 'custom agent TOMLs, concurrency and agent model defaults',
};

/** Parse an explicit component selection without accepting arbitrary paths. */
export function parseCopySelection(value, components) {
  if (!Array.isArray(components) || !components.length || components.some(component => typeof component !== 'string' || !component))
    throw new Error('Invalid copy components');
  const input = String(value ?? '').trim().toLowerCase();
  if (input === 'q' || input === 'quit') return null;
  if (input === 'all') return [...components];
  if (!input) return undefined;
  const byNumber = input.split(',').map(part => part.trim());
  if (!byNumber.length || byNumber.some(part => !part)) return undefined;
  const selected = new Set();
  for (const part of byNumber) {
    let component;
    if (/^[1-9]\d*$/.test(part)) component = components[Number(part) - 1];
    else component = components.find(candidate => candidate.toLowerCase() === part);
    if (!component) return undefined;
    selected.add(component);
  }
  return components.filter(component => selected.has(component));
}

/** Ask only for the supported native settings components. */
export async function pickCopyComponents(components, { input = process.stdin, output = process.stdout, signal } = {}) {
  const writeMenu = () => {
    output.write('\nChoose native settings to copy\n');
    components.forEach((component, index) => output.write(`${index + 1}. ${display(component)}${descriptions[component] ? ' — ' + descriptions[component] : ''}\n`));
    output.write('History, authentication, desktop data, skills, and plugins are not copied.\n');
    output.write('Numbers or names separated by commas; all; q: cancel\n> ');
  };
  const lines = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const abort = () => lines.close();
  signal?.addEventListener('abort', abort, { once: true });
  lines.on('SIGINT', abort);
  writeMenu();
  try {
    if (signal?.aborted) return null;
    for await (const line of lines) {
      const selected = parseCopySelection(line, components);
      if (selected === null) return null;
      if (selected?.length) return selected;
      output.write('Choose listed numbers or names, all, or q.\n> ');
    }
    return null;
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
  }
}

/** Require an exact action word before a local destructive operation. */
export async function confirmCopyAction(action, { input = process.stdin, output = process.stdout, signal } = {}) {
  if (typeof action !== 'string' || !/^[a-z]+$/.test(action)) throw new Error('Invalid confirmation action');
  const lines = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const abort = () => lines.close();
  signal?.addEventListener('abort', abort, { once: true });
  lines.on('SIGINT', abort);
  output.write(`Type ${action} to continue; any other input cancels: `);
  try {
    if (signal?.aborted) return false;
    for await (const line of lines) return line.trim() === action;
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
  }
}
