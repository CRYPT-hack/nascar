import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@vehicle': r('./vehicle'),
      '@track': r('./track/src'),
      '@client': r('./client/src'),
    },
  },
  server: {
    host: true, // bind 0.0.0.0 so LAN players can join — HANDOFF.md §9
    port: 5173,
    strictPort: true,
  },
  preview: { host: true, port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Both entries listed explicitly. index.html is the game and is what the
      // demo serves; preview.html is the track/environment viewer. Naming only
      // one here silently drops the other from `npm run build`.
      input: { main: r('./index.html'), preview: r('./preview.html') },
    },
  },
  optimizeDeps: {
    // rapier ships wasm inlined as base64 in the -compat build; let vite prebundle it
    include: ['@dimforge/rapier3d-compat', 'three'],
  },
});
