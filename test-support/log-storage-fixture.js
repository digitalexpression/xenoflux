// Subprocess fixtures must never mount a native RAM volume.
export function createLogStorage() {
  return {
    ensureMounted: async () => '/test/RAM',
    prepareHome: async ({ home, key }) => ({ kind: 'ram', home, key, target: '/test/RAM/logs_2.sqlite', persistent: false }),
    inspect: async ({ home, key }) => ({ kind: 'ram', home, key, mounted: true, available: true, linked: true, state: 'ready', persistent: false }),
  };
}

export async function readLogSettings() { return { enabled: false }; }
