// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { RemoteClipboardEvent } from './api';
import { clipboardStore, openClipboardStore, type QueuedEvent } from './store';
import { wipeAccountData } from '../account/keyFlow';

const ev = (id: string, seq: number): RemoteClipboardEvent => ({
  event_id: id,
  seq,
  origin_device_id: 'd',
  event_type: 'TEXT',
  mime_type: 'text/plain',
  key_version: 1,
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAA',
  payload_size: 3,
  created_at: '2026-11-11T00:00:00Z',
  expires_at: '2026-11-18T00:00:00Z',
  deleted: false,
});
const q = (userId: string, id: string, at: number): QueuedEvent => ({
  userId,
  event_id: id,
  key_version: 1,
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAA',
  payload_size: 3,
  queuedAt: at,
});

describe('clipboard store (IndexedDB, docs/CLIPBOARD_PROTOCOL.md §2.8)', () => {
  it('keeps accounts apart, never moves the cursor backwards, and orders the queue by capture time', async () => {
    const s = openClipboardStore(new IDBFactory());
    expect(await s.cursor('u1')).toBeNull();
    await s.replace('u1', [ev('a', 1), ev('b', 2)], 2);
    await s.apply('u2', { put: [ev('x', 9)], cursor: 9 });
    await s.apply('u1', { put: [ev('c', 3)], remove: ['a'], cursor: 3 });
    await s.apply('u1', { cursor: 1 });
    expect(await s.cursor('u1')).toBe(3);
    expect((await s.events('u1')).map((e) => e.event_id).sort()).toEqual(['b', 'c']);
    expect((await s.events('u2')).map((e) => e.event_id)).toEqual(['x']);
    await s.enqueue(q('u1', 'late', 20));
    await s.enqueue(q('u1', 'early', 10));
    await s.enqueue(q('u2', 'other', 5));
    expect((await s.queue('u1')).map((e) => e.event_id)).toEqual(['early', 'late']);
    await s.dequeue('u1', 'early');
    expect((await s.queue('u1')).map((e) => e.event_id)).toEqual(['late']);
    await s.wipe();
    expect(await s.events('u1')).toEqual([]);
    expect(await s.queue('u2')).toEqual([]);
    expect(await s.cursor('u1')).toBeNull();
  });

  it('leaving the account (wipeAccountData) erases the clipboard cache, queue and cursor too', async () => {
    const s = clipboardStore();
    await s.replace('u1', [ev('a', 1)], 1);
    await s.enqueue(q('u1', 'pending', 1));
    await wipeAccountData();
    expect(await s.events('u1')).toEqual([]);
    expect(await s.queue('u1')).toEqual([]);
    expect(await s.cursor('u1')).toBeNull();
  });
});
