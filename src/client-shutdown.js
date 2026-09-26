import { createInterface } from 'node:readline';

const display = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400);

/** One explicit approval for the app list observed by the runtime. */
export async function confirmClientShutdown(apps, { input = process.stdin, output = process.stdout, signal } = {}) {
  if (!input.isTTY || !output.isTTY || signal?.aborted || !apps.length) return false;
  const lines = createInterface({ input, output, terminal: true });
  const abort = () => lines.close();
  signal?.addEventListener('abort', abort, { once: true });
  lines.on('SIGINT', abort);
  output.write('\nThese applications are using Codex:\n');
  for (const app of apps) output.write(`  ${display(app.name)} (${display(app.appPath)})\n`);
  output.write('Save work if prompted. Cancelling an application’s Quit stops this command.\n');
  output.write('Quit these applications gracefully and continue? [y/N] ');
  try {
    for await (const line of lines) return !signal?.aborted && ['y', 'yes'].includes(line.trim().toLowerCase());
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
  }
}
