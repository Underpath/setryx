import { defineConfig, devices } from '@playwright/test';

// Runs inside the Playwright container (see docker-compose.e2e.yml) against a
// throwaway setryx container with an empty database.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://app:38471',
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
  },
});
