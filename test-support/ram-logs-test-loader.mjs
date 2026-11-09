// Test-only loader for subprocess coverage that must exercise the public CLI
// without attempting to mount a native RAM volume.
const stubURL = new URL('./log-storage-fixture.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './log-storage.js' && context.parentURL?.endsWith('/src/launcher.js'))
    return { url: stubURL, shortCircuit: true };
  return nextResolve(specifier, context);
}
