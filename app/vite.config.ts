import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The sandbox preview is served from an *.e2b.app host.
    allowedHosts: true,
    cors: true,
    hmr: { clientPort: 443, protocol: 'wss' },
  },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true, allowedHosts: true },
  worker: { format: 'es' },
  build: { target: 'es2022', cssTarget: 'chrome100', reportCompressedSize: false },
});
