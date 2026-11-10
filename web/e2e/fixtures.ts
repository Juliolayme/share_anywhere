import { expect, type Page, type Response } from '@playwright/test';

export const isMobileProject = (name: string) => name === 'android-chrome' || name === 'ios-safari';

/** Waits for the device-session response the app receives during bootstrap, refresh, or reset. */
export async function deviceIdFrom(responsePromise: Promise<Response>): Promise<string> {
  const res = await responsePromise;
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { device: { id: string } };
  return body.device.id;
}

export const sessionResponse = (page: Page) =>
  page.waitForResponse(
    (r) =>
      /\/v1\/devices\/(token|anonymous|current\/reset)$/.test(r.url()) && r.request().method() === 'POST' && r.ok(),
  );

/** Opens the app as a returning guest (Welcome already seen) at `path`. */
export async function openAsReturningGuest(page: Page, path = '/') {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
    } catch {
      /* storage blocked */
    }
  });
  await page.goto(path);
}
