import { defineConfig, devices } from '@playwright/test';

// Two browser processes on one runner reach each other only through real host addresses: hide-behind-mDNS
// is a privacy feature for the open web that CI has no resolver for (docs/TESTING_AND_CI.md §3).
export const chromiumWebRtc = { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] };
// No proxy for the test browser: the suite only talks to localhost, and a system proxy picked up from the
// environment stops Firefox from gathering ICE candidates on every page after the first (docs/TESTING_AND_CI.md §3).
export const firefoxPrefs = { 'media.peerconnection.ice.obfuscate_host_addresses': false, 'network.proxy.type': 0 };
// Playwright's patched Firefox never gathers ICE candidates (docs/TESTING_AND_CI.md §3), so when
// E2E_FIREFOX_BIN points at a stock Firefox the project drives it over WebDriver BiDi instead.
const firefox = process.env.E2E_FIREFOX_BIN
  ? {
      channel: 'moz-firefox',
      launchOptions: { executablePath: process.env.E2E_FIREFOX_BIN, firefoxUserPrefs: firefoxPrefs },
    }
  : { launchOptions: { firefoxUserPrefs: firefoxPrefs } };

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
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], ...firefox } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'android-chrome', use: { ...devices['Pixel 7'], launchOptions: chromiumWebRtc } },
    { name: 'ios-safari', use: { ...devices['iPhone 14'] } },
  ],
});
