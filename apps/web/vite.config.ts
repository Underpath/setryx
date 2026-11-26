import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const apiPort = process.env.PORT || '38471';

export default defineConfig({
  plugins: [
    react(),
    // Installable app with an offline-capable shell. Browsers only run service
    // workers over HTTPS (or on localhost); over plain HTTP this is simply inert.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Setryx',
        short_name: 'Setryx',
        description: 'Your workouts, on your own server.',
        theme_color: '#1C2126',
        background_color: '#1C2126',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Take over as soon as a new version is installed; otherwise it waits
        // until every setryx tab is closed, which on a phone can be days.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Read-only data needed to start a workout with no connection. Network
        // first: the cache is only used when the server can't be reached.
        runtimeCaching: [
          // Exercise photos: from the server while it's reachable (so turning them off takes effect),
          // and the ones you've seen from the cache in a gym with no signal.
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/v1/exercise-images/'),
            handler: 'NetworkFirst',
            options: { cacheName: 'setryx-photos', networkTimeoutSeconds: 4, expiration: { maxEntries: 400 }, cacheableResponse: { statuses: [200] } },
          },
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && /^\/api\/v1\/(auth\/me|setup|workouts|exercises|routines)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'setryx-api', networkTimeoutSeconds: 4, expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
  build: { outDir: 'dist', sourcemap: false },
});
