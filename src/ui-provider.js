// Choose the data source behind the local app: the audit engine, or
// synthetic demo data that never touches the user's profiles.
import { readFile } from 'node:fs/promises';
import { createDemoProvider } from './ui-demo.js';
import { createEngineProvider } from './ui-engine.js';

async function packageVersion() {
  try { return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return 'unknown'; }
}

export async function createUiProvider({ store, demo = false, ...options }) {
  const version = await packageVersion();
  return demo ? createDemoProvider({ version }) : createEngineProvider({ store, version, ...options });
}
