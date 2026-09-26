// Terminal acknowledgement before an explicitly requested desktop operation.
import { createInterface } from 'node:readline/promises';

export function desktopReady({ input = process.stdin, output = process.stdout, noOpen = false } = {}) {
  return async ({ signal }) => {
    const rl = createInterface({ input, output });
    const closed = new Promise(resolve => rl.once('close', () => resolve(null)));
    rl.once('SIGINT', () => rl.close());
    try {
      if (noOpen) output.write('Close Codex desktop and all Codex CLI/IDE sessions first. Recovery will restore owned paths and leave Codex closed.\n');
      else {
        output.write('Wait for the current Codex response to finish before starting.\n');
        output.write('If Codex then shows an active-task quit confirmation, confirm Quit within 60 seconds.\n');
      }
      const value = await Promise.race([rl.question('Press Enter when ready; any text cancels: ', { signal }), closed]);
      return value === '' && !signal?.aborted;
    } catch (e) { if (signal?.aborted) return false; throw e; }
    finally { rl.close(); }
  };
}
