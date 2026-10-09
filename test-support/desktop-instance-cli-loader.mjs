// Native discovery is mocked only inside these subprocess fixture checks.
import { readFile } from 'node:fs/promises';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/desktop-instance-runtime.js')) {
    const source = (await readFile(new URL(url), 'utf8')).replace('export function createDesktopInstanceRuntime(', 'function originalCreateDesktopInstanceRuntime(');
    return { format: 'module', shortCircuit: true, source: `${source}\nexport function createDesktopInstanceRuntime() {
      return { inspectApp: async () => ({appPath:'/fixture/Codex.app',bundleId:'com.openai.codex',executable:'/fixture/Codex.app/Contents/MacOS/Codex'}),
        snapshot: async () => [], open: async () => { throw new Error('Native launches are forbidden in this fixture'); } };
    }` };
  }
  return nextLoad(url, context);
}
