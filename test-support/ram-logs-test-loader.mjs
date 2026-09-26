// Test-only loader for subprocess coverage that must exercise the public CLI
// without attempting to mount a native RAM volume.
const stub = `export function createLogStorage() {
  return {
    ensureMounted: async () => '/test/RAM',
    prepareHome: async ({ home, key }) => ({ kind: 'ram', home, key, target: '/test/RAM/logs_2.sqlite', persistent: false }),
    inspect: async ({ home, key }) => ({ kind: 'ram', home, key, mounted: true, available: true, linked: true, state: 'ready', persistent: false }),
  };
}`;
const stubURL = `data:text/javascript,${encodeURIComponent(stub)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './log-storage.js' && context.parentURL?.endsWith('/src/launcher.js'))
    return { url: stubURL, shortCircuit: true };
  return nextResolve(specifier, context);
}
