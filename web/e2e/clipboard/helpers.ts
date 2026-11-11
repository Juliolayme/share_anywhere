import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE, open, trackContext } from '../pairing/helpers';
import { PASSWORD, chooseAndContinue, saveRecoveryPhrase, typeInto, type Choices } from '../account/helpers';

// Clipboard specs (docs/TESTING_AND_CI.md §3): every test creates its own account; helpers reuse the account and
// pairing helpers. Clipboard calls are counted by an init script so a spec can prove a guest made none.

export interface ClipboardCalls {
  readText: number;
  writeText: number;
  read: number;
  write: number;
  /** navigator.permissions.query calls (any name). */
  query: number;
  /** copy / paste listeners registered on the document or window. */
  copyListeners: number;
}

export interface InstrumentOptions {
  /**
   * Make `readText` refuse like a browser that needs its own Paste UI or a permission the user has not given
   * (NotAllowedError). Playwright cannot click Firefox's or Safari's Paste button or answer Chrome's permission prompt,
   * so the denied / gesture-required path is driven this way; capability detection stays real.
   */
  denyRead?: boolean;
}

/**
 * Counts every clipboard API call, permission query, and copy/paste listener in the context (window.__cb), before any
 * app script runs.
 */
export async function instrumentClipboard(ctx: BrowserContext, opts: InstrumentOptions = {}) {
  await ctx.addInitScript((deny: boolean) => {
    const rec = { readText: 0, writeText: 0, read: 0, write: 0, query: 0, copyListeners: 0 };
    (window as unknown as { __cb: typeof rec }).__cb = rec;
    const C = (window as unknown as { Clipboard?: { prototype: Record<string, unknown> } }).Clipboard;
    if (C) {
      for (const m of ['readText', 'writeText', 'read', 'write'] as const) {
        const orig = C.prototype[m] as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (typeof orig !== 'function') continue;
        C.prototype[m] = function (this: unknown, ...args: unknown[]) {
          rec[m]++;
          if (m === 'readText' && deny)
            return Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'));
          return orig.apply(this, args);
        };
      }
    }
    const P = (window as unknown as { Permissions?: { prototype: { query: (d: unknown) => Promise<unknown> } } })
      .Permissions;
    if (P) {
      const q = P.prototype.query;
      P.prototype.query = function (this: unknown, d: unknown) {
        rec.query++;
        return q.call(this, d);
      };
    }
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if ((type === 'copy' || type === 'paste') && (this === document || this === window)) rec.copyListeners++;
      return (add as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof EventTarget.prototype.addEventListener;
  }, opts.denyRead === true);
}

export async function clipboardCalls(page: Page): Promise<ClipboardCalls> {
  return page.evaluate(() => (window as unknown as { __cb: ClipboardCalls }).__cb);
}

/** A fresh context (Welcome seen) with clipboard instrumentation and, in Chromium, granted clipboard permissions. */
export async function clipboardPage(
  browser: Browser,
  opts: InstrumentOptions & { grant?: boolean; baseURL?: string } = {},
): Promise<Page> {
  const ctx = trackContext(
    await browser.newContext({
      baseURL: opts.baseURL ?? BASE,
      locale: 'en-US',
      permissions: opts.grant ? ['clipboard-read', 'clipboard-write'] : [],
    }),
  );
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
    } catch {
      /* ignore */
    }
  });
  await instrumentClipboard(ctx, opts);
  return ctx.newPage();
}

export const screen = (page: Page, id: string) => page.locator(`[data-screen="${id}"]`);

async function credentials(page: Page, email: string) {
  await typeInto(page.getByRole('textbox', { name: 'Email' }), email);
  await typeInto(page.getByLabel('Password', { exact: true }), PASSWORD);
}

/** AC-8 reached from Clipboard: its action is "Go to Clipboard". */
export async function goToClipboard(page: Page) {
  await expect(screen(page, 'checklist')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Go to Clipboard' }).click();
  await expect(page).toHaveURL(/\/clipboard$/);
}

/** Creates the account from the Clipboard intro (CB-1 → AC-2 → AC-4 → AC-5 → AC-8 → CB-4). Returns the phrase. */
export async function signUpFromClipboard(page: Page, email: string): Promise<string> {
  await open(page, '/clipboard');
  await expect(page.getByRole('heading', { name: 'Clipboard Sync' })).toBeVisible();
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/signup\?returnTo=%2Fclipboard$/);
  await credentials(page, email);
  await page.getByRole('button', { name: 'Create account' }).click();
  await chooseAndContinue(page, { add: true });
  const phrase = await saveRecoveryPhrase(page);
  await goToClipboard(page);
  await expect(page.getByTestId('cb-status')).toBeVisible({ timeout: 30_000 });
  return phrase;
}

/** Signs in from the Clipboard intro (CB-1 → AC-1 → AC-4); the caller continues from the next step. */
export async function signInFromClipboard(page: Page, email: string, choices: Choices = {}) {
  await open(page, '/clipboard');
  await expect(page.getByRole('heading', { name: 'Clipboard Sync' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).last().click();
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fclipboard$/);
  await credentials(page, email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await chooseAndContinue(page, choices);
}

/** A (ready) sends its key to B (on AC-6) with B's pasted pairing code; B then reaches AC-8. */
export async function pairByCode(a: Page, b: Page) {
  await expect(screen(b, 'key-pair')).toBeVisible();
  const code = (await b.getByTestId('pairing-code').textContent())?.trim() ?? '';
  await open(a, '/devices');
  await a.getByRole('button', { name: 'Pair a new device' }).click();
  const dialog = a.getByRole('dialog', { name: 'Pair a new device' });
  await typeInto(dialog.getByRole('textbox', { name: 'Code from the new device' }), code);
  await dialog.getByRole('button', { name: 'Find device' }).click();
  await dialog.getByRole('button', { name: 'Send key' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Syncs `text` through the paste fallback: Sync Clipboard (readText refused by the instrumentation) → the paste form →
 * Sync this text. Waits until the row shows.
 */
export async function syncByPaste(page: Page, text: string) {
  await page.getByRole('button', { name: 'Sync Clipboard' }).click();
  const form = page.getByTestId('cb-paste');
  await expect(form).toBeVisible();
  await typeInto(form.getByRole('textbox', { name: 'Text to sync' }), text);
  await form.getByRole('button', { name: 'Sync this text' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId('cb-item-text').filter({ hasText: text })).toBeVisible();
}

/** Fires the events automatic capture listens to (focus and visibility), as switching back to the tab does. */
export async function refocus(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** ADK versions held in this browser's key store (IndexedDB `share-anywhere-keys`). */
export async function heldKeyVersions(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const r = indexedDB.open('share-anywhere-keys');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('adk')) {
            db.close();
            resolve([]);
            return;
          }
          const q = db.transaction('adk', 'readonly').objectStore('adk').getAllKeys();
          q.onsuccess = () => {
            db.close();
            resolve((q.result as unknown[]).map(Number));
          };
          q.onerror = () => resolve([]);
        };
        r.onerror = () => resolve([]);
      }),
  );
}

/** Records in this browser's clipboard cache and queue (IndexedDB `share-anywhere-clipboard`). */
export async function clipboardRecords(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open('share-anywhere-clipboard');
        r.onsuccess = () => {
          const db = r.result;
          const stores = ['events', 'queue'].filter((s) => db.objectStoreNames.contains(s));
          if (!stores.length) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(stores, 'readonly');
          let n = 0;
          for (const s of stores) {
            const c = tx.objectStore(s).count();
            c.onsuccess = () => (n += c.result);
          }
          tx.oncomplete = () => {
            db.close();
            resolve(n);
          };
        };
        r.onerror = () => resolve(0);
      }),
  );
}

/**
 * `key_version` of each event in this browser's clipboard cache, by ascending `seq` (the server accepted each one, and
 * it accepts only the account's current version). Read from IndexedDB because WebDriver BiDi does not expose request
 * bodies to Playwright.
 */
export async function cachedKeyVersions(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const r = indexedDB.open('share-anywhere-clipboard');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('events')) {
            db.close();
            resolve([]);
            return;
          }
          const q = db.transaction('events', 'readonly').objectStore('events').getAll();
          q.onsuccess = () => {
            db.close();
            const rows = q.result as { seq: number; key_version: number }[];
            resolve(rows.sort((x, y) => x.seq - y.seq).map((e) => e.key_version));
          };
          q.onerror = () => resolve([]);
        };
        r.onerror = () => resolve([]);
      }),
  );
}
