import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';

/** Resolve the explicit, environment, or standard controller directory. */
export async function controllerLocation(explicit, environment = process.env.XFX_HOME, home = userInfo().homedir) {
  let selected = explicit ?? environment ?? join(home, '.xfx', 'controller');
  if (typeof selected !== 'string' || !selected.trim() || selected.length > 4096)
    throw new Error('Store directory must be a nonempty string of at most 4096 characters');
  selected = resolve(selected);
  return selected;
}
