import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { BASE, closeContexts, guestPage, open, renameDevice } from '../pairing/helpers';
import { finishChecklist, signIn, signUp, typeInto, uniqueEmail } from './helpers';
import { adkFromPhrase, proofBy } from './keys-node';

// QA round 1 P0-1 (docs/CLIPBOARD_PROTOCOL.md §1.13): someone who knows only the password signs in, adds a browser,
// and tries to push an ADK of its own. The server refuses the unsigned rotation and the unproven device key; the
// client-side refusal of a forged rotation blob is covered by Vitest (authenticity.test.ts, keyFlow.test.ts).
test.afterEach(closeContexts);

const b64u = (n: number) => randomBytes(n).toString('base64url');

/** The bearer token the app sends (access tokens live in memory only, so read it off a request). */
function bearer(page: Page): () => string {
  let token = '';
  page.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ') && r.url().startsWith(`${BASE}/v1/`)) token = h;
  });
  return () => token;
}

interface KeysState {
  key_version: number;
  rotation_due?: boolean;
  devices: { device_id: string; public_key: string | null; key_version: number | null; proof: string | null }[];
  pending?: { key_version: number }[];
}

/** AC-6 with the recovery phrase on `page` (signed in, added, on the pairing screen). */
async function recoverWithPhrase(page: Page, phrase: string) {
  await page.getByRole('button', { name: 'Use recovery phrase' }).click();
  await typeInto(page.getByRole('textbox', { name: 'Recovery phrase' }), phrase);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await finishChecklist(page);
}

async function keysOf(page: Page, authorization: string): Promise<KeysState> {
  const res = await page.request.get(`${BASE}/v1/keys`, { headers: { Authorization: authorization } });
  expect(res.status()).toBe(200);
  return (await res.json()) as KeysState;
}

test('a password-only attacker cannot rotate the account key or register an unproven device key', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('attack');
  const a = await guestPage(browser);
  await signUp(a, email);

  const x = await guestPage(browser);
  const token = bearer(x);
  await signIn(x, email);
  // Added, but without the key: AC-6. Its device key is not registered (it holds no ADK).
  await expect(x.locator('[data-screen="key-pair"]')).toBeVisible();
  await expect.poll(token).toMatch(/^Bearer /);
  const headers = { Authorization: token() };
  const keysRes = await x.request.get(`${BASE}/v1/keys`, { headers });
  expect(keysRes.status()).toBe(200);
  const keys = (await keysRes.json()) as KeysState;
  expect(keys.key_version).toBe(1);
  expect(keys.devices).toHaveLength(2);
  const withKey = keys.devices.filter((d) => d.public_key);
  expect(withKey).toHaveLength(1);
  expect(withKey[0]?.key_version).toBe(1);
  expect(withKey[0]?.proof).toBeTruthy();

  // A rotation to an ADK of the attacker's choosing, signed with a key it made up: 403, nothing stored.
  const rotate = await x.request.post(`${BASE}/v1/keys/rotate`, {
    headers,
    data: {
      key_version: 2,
      recovery_blob: b64u(92),
      chain_blob: b64u(60),
      device_blobs: withKey.map((d) => ({ device_id: d.device_id, blob: b64u(92) })),
      verify_key: b64u(32),
      signature: b64u(64),
    },
  });
  expect(rotate.status()).toBe(403);
  expect(((await rotate.json()) as { error: string }).error).toBe('rotation_unauthorized');

  // A device key "proven" by a key the attacker does not have: 403, so no rotation would ever wrap to it.
  const register = await x.request.put(`${BASE}/v1/keys/device`, {
    headers,
    data: { public_key: b64u(32), key_version: 1, proof: b64u(64) },
  });
  expect(register.status()).toBe(403);
  expect(((await register.json()) as { error: string }).error).toBe('device_key_unproven');

  const after = (await (await x.request.get(`${BASE}/v1/keys`, { headers })).json()) as KeysState;
  expect(after.key_version).toBe(1);
  expect(after.devices.filter((d) => d.public_key)).toHaveLength(1);

  // The real device is unaffected: still version 1 and ready.
  await open(a, '/settings');
  await expect(a.getByTestId('key-status')).toContainText('Encryption key on this device');
});

test('a not-added session ends with the browser session (sa_acct cookie gone); an added one does not', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('binding');
  const owner = await guestPage(browser);
  await signUp(owner, email);

  // Not added: the server bound the session to a browser-session cookie.
  const guest = await guestPage(browser);
  await signIn(guest, email, { add: false });
  await expect(guest.locator('[data-screen="checklist"]')).toBeVisible({ timeout: 30_000 });
  await open(guest, '/settings');
  await expect(guest.getByTestId('identity-label')).toHaveText(email);
  const cookies = await guest.context().cookies();
  const binding = cookies.find((c) => c.name === 'sa_acct');
  expect(binding).toBeTruthy();
  expect(binding?.httpOnly).toBe(true);
  expect(binding?.expires).toBe(-1); // a session cookie: no Max-Age / Expires
  // "Closing the browser" drops session cookies: the next load is a guest on the same device identity.
  await guest.context().clearCookies({ name: 'sa_acct' });
  await guest.reload();
  await open(guest, '/settings');
  await expect(guest.getByTestId('identity-label')).toHaveText('Guest', { timeout: 30_000 });

  // Added sessions carry no binding: clearing the (absent) cookie and reloading keeps the account.
  expect((await owner.context().cookies()).some((c) => c.name === 'sa_acct')).toBe(false);
  await owner.context().clearCookies({ name: 'sa_acct' });
  await owner.reload();
  await open(owner, '/settings');
  await expect(owner.getByTestId('identity-label')).toHaveText(email);
  await expect(owner.getByTestId('key-status')).toContainText('Encryption key on this device');
});

// QA round 2 P1-A / P2-1 (docs/CLIPBOARD_PROTOCOL.md §1.11): a revoked laptop kept ADK v1 and its owner's password.
// After the owner rotated to v2, a device key proven with v1 is refused (409 key_version_conflict), so no later
// rotation wraps the new key to it; a device holding the key that signs out leaves a rotation owed, which the owner's
// browser makes on its next key check without the refused device.
test('an old-version device key proof is refused and the owner’s next (owed) rotation goes ahead without it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('stale');
  const a = await guestPage(browser);
  const aToken = bearer(a);
  const phrase = (await signUp(a, email)) ?? '';
  await expect.poll(aToken).toMatch(/^Bearer /);
  // What the laptop keeps: ADK v1 (the spec opens it with the phrase while v1 is current).
  const v1 = await adkFromPhrase(a.request, aToken(), phrase);
  expect(v1.keyVersion).toBe(1);

  // The laptop gets the key (recovery phrase), then the owner revokes it: the key rotates to v2 without it.
  const laptop = await guestPage(browser);
  await renameDevice(laptop, 'Old Laptop');
  await signIn(laptop, email);
  await recoverWithPhrase(laptop, phrase);
  await open(a, '/devices');
  await a.getByRole('button', { name: 'Revoke Old Laptop' }).click();
  await a.getByRole('dialog', { name: 'Revoke Old Laptop?' }).getByRole('button', { name: 'Revoke device' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Old Laptop revoked · keys rotated' })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(async () => (await keysOf(a, aToken())).key_version).toBe(2);

  // The thief signs in with the password on another browser and proves a device key with the kept v1.
  const thief = await guestPage(browser);
  const thiefToken = bearer(thief);
  await signIn(thief, email);
  await expect(thief.locator('[data-screen="key-pair"]')).toBeVisible();
  await expect.poll(thiefToken).toMatch(/^Bearer /);
  const me = (await (
    await thief.request.get(`${BASE}/v1/me`, { headers: { Authorization: thiefToken() } })
  ).json()) as { device: { id: string } };
  const stale = await thief.request.put(`${BASE}/v1/keys/device`, {
    headers: { Authorization: thiefToken() },
    data: await proofBy(v1.adk, 1, me.device.id),
  });
  expect(stale.status()).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toBe('key_version_conflict');
  const afterStale = await keysOf(a, aToken());
  expect(afterStale.devices.find((d) => d.device_id === me.device.id)?.public_key ?? null).toBeNull();

  // A device holding v2 (a spare browser, recovered with the phrase) signs out: a rotation is now owed.
  const spare = await guestPage(browser);
  await signIn(spare, email);
  await recoverWithPhrase(spare, phrase);
  await open(spare, '/settings');
  await expect(spare.getByTestId('key-status')).toContainText('Encryption key on this device');
  await spare.getByRole('button', { name: 'Sign out' }).click();
  const dialog = spare.getByRole('dialog', { name: 'Sign out of this browser?' });
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(spare.getByTestId('identity-label')).toHaveText('Guest');

  // The owner's next key check rotates to v3; the server asks no blob for the refused device and it gets none.
  await open(a, '/settings');
  await expect
    .poll(
      async () => {
        const k = await keysOf(a, aToken());
        return `${k.key_version}:${k.rotation_due}`;
      },
      { timeout: 30_000 },
    )
    .toBe('3:false');
  await expect(a.getByTestId('key-status')).toContainText('Encryption key on this device');
  const thiefKeys = await keysOf(thief, thiefToken());
  expect(thiefKeys.pending ?? []).toEqual([]);
  expect(thiefKeys.devices.find((d) => d.device_id === me.device.id)?.public_key ?? null).toBeNull();
});
