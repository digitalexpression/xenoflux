import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The built app is served by `xfx ui` from dist/ui; nothing loads from a CDN.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
});
