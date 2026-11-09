// Test-only imports for guided-profile CLI subprocesses. These stubs prevent
// host desktop discovery and RAM-volume operations while keeping the real
// profile wizard, setup persistence, and interactive child runner in use.
const desktopStub = `export function createDesktopRuntime() {
  return { assertExternal: async () => {}, assertIdle: async () => {}, inspectApp: async () => null };
}`;
const urls = new Map([
  ['./desktop-runtime.js', `data:text/javascript,${encodeURIComponent(desktopStub)}`],
  ['./log-storage.js', new URL('./log-storage-fixture.js', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/bin/xfx.js')) {
    if (specifier === '../src/desktop-runtime.js') return { url: urls.get('./desktop-runtime.js'), shortCircuit: true };
    if (specifier === '../src/log-storage.js') return { url: urls.get('./log-storage.js'), shortCircuit: true };
  }
  if (specifier === './log-storage.js' && context.parentURL?.endsWith('/src/home-create.js'))
    return { url: urls.get('./log-storage.js'), shortCircuit: true };
  return nextResolve(specifier, context);
}
