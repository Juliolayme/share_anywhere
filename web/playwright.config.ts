import { defineConfig, devices } from '@playwright/test';

// Two browser processes on one runner reach each other only through real host addresses: hide-behind-mDNS
// is a privacy feature for the open web that CI has no resolver for (docs/TESTING_AND_CI.md §3).
export const chromiumWebRtc = { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] };
const firefoxWebRtc = { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } };

// docs/TESTING_AND_CI.md §3. The suite runs against the Compose CI stack (docker-compose.ci.yml) on
// http://localhost:8080 unless E2E_BASE_URL points elsewhere.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: pairing specs move the test server's clock and toggle protected mode, which are global.
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'off',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read', 'clipboard-write'],
        launchOptions: chromiumWebRtc,
      },
    },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], launchOptions: firefoxWebRtc } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'android-chrome', use: { ...devices['Pixel 7'], launchOptions: chromiumWebRtc } },
    { name: 'ios-safari', use: { ...devices['iPhone 14'] } },
  ],
});
