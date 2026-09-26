import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
export const BACKGROUND_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const NODE_REQUIREMENT = '22.13.0+ (22.x) or 23.4.0+';

export function nativePath(environment = process.env) {
  const entries = (environment.PATH || BACKGROUND_PATH).split(path.delimiter);
  if (entries.some(entry => !path.isAbsolute(entry) || /[\0\r\n]/.test(entry))) {
    throw new Error('PATH must contain only absolute directories without control characters');
  }
  return [...new Set(entries)].join(path.delimiter);
}

export function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

export async function checkNode({ env = process.env, execute = run } = {}) {
  const environment = { ...env, PATH: nativePath(env) };
  let version;
  try {
    const result = await execute('node', ['--version'], { env: environment });
    version = result.stdout.trim();
  } catch (cause) {
    throw new Error('Node is unavailable on PATH. Install Node yourself and make it available to this environment.', { cause });
  }
  if (!supportedNode(version)) throw new Error(`Node ${NODE_REQUIREMENT} is required; found ${version}`);
  return version;
}
