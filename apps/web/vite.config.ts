import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT || '38471';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
  build: { outDir: 'dist', sourcemap: false },
});
