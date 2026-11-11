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

describe('clipboard store (IndexedDB, docs/CLIPBOARD_PROTOCOL.md §2.9)', () => {
  it('keeps accounts apart, never moves the cursor backwards, and orders the queue by capture time', async () => {
    const s = openClipboardStore(new IDBFactory());
    const g = await s.generation();
    expect(await s.generation()).toBe(g);
    expect(await s.cursor('u1')).toBeNull();
    await s.replace('u1', [ev('a', 1), ev('b', 2)], 2, g);
    await s.replace('u2', [], 0, g);
    expect(await s.advance('u2', { put: [ev('x', 9)], from: 0, to: 9 }, g)).toBe('ok');
    expect(await s.advance('u1', { put: [ev('c', 3)], remove: ['a'], from: 2, to: 3 }, g)).toBe('ok');
    // A page pulled from a cursor that is no longer the stored one, or one that would move it back, writes nothing.
    expect(await s.advance('u1', { put: [ev('stale', 2)], from: 2, to: 4 }, g)).toBe('moved');
    expect(await s.advance('u1', { from: 3, to: 1 }, g)).toBe('moved');
    expect(await s.cursor('u1')).toBe(3);
    // A history load older than a fresh stored cursor keeps the newer pair.
    expect(await s.replace('u1', [ev('old', 1)], 1, g)).toBe(true);
    expect(await s.cursor('u1')).toBe(3);
    expect((await s.events('u1')).map((e) => e.event_id).sort()).toEqual(['b', 'c']);
    expect((await s.events('u2')).map((e) => e.event_id)).toEqual(['x']);
    await s.enqueue(q('u1', 'late', 20), g);
    await s.enqueue(q('u1', 'early', 10), g);
    await s.enqueue(q('u2', 'other', 5), g);
    expect((await s.queue('u1')).map((e) => e.event_id)).toEqual(['early', 'late']);
    await s.dequeue('u1', 'early', g);
    expect((await s.queue('u1')).map((e) => e.event_id)).toEqual(['late']);
    await s.wipe();
    expect(await s.events('u1')).toEqual([]);
    expect(await s.queue('u2')).toEqual([]);
    expect(await s.cursor('u1')).toBeNull();
  });

  it('a wipe in one tab starts a new generation: writes from another tab started before it change nothing', async () => {
    const factory = new IDBFactory();
    // Two tabs of one browser: two connections to the same database.
    const tabA = openClipboardStore(factory);
    const tabB = openClipboardStore(factory);
    const gA = await tabA.generation();
    expect(await tabB.generation()).toBe(gA);
    expect(await tabA.enqueue(q('u1', 'before', 1), gA)).toBe(true);
    await tabB.wipe();
    const gB = await tabB.generation();
    expect(gB).not.toBe(gA);
    expect(await tabA.generation()).toBe(gB);
    // Tab A still runs with the old generation: every write is refused inside its transaction.
    expect(await tabA.enqueue(q('u1', 'stale', 2), gA)).toBe(false);
    expect(await tabA.advance('u1', { put: [ev('a', 1)], from: 0, to: 1 }, gA)).toBe(false);
    expect(await tabA.ackCreate('u1', ev('a', 1), gA)).toBe(false);
    expect(await tabA.removeEvents('u1', ['a'], gA)).toBe(false);
    expect(await tabA.replace('u1', [ev('b', 2)], 2, gA)).toBe(false);
    expect(await tabA.dequeue('u1', 'before', gA)).toBe(false);
    expect(await tabB.queue('u1')).toEqual([]);
    expect(await tabB.events('u1')).toEqual([]);
    expect(await tabB.cursor('u1')).toBeNull();
    // A runtime started after the wipe writes normally.
    expect(await tabA.enqueue(q('u1', 'after', 3), gB)).toBe(true);
    expect((await tabB.queue('u1')).map((e) => e.event_id)).toEqual(['after']);
  });

  it('pending deletes: one transaction takes the event out of the queue and the cache; guarded and wiped like the rest', async () => {
    const factory = new IDBFactory();
    const tabA = openClipboardStore(factory);
    const tabB = openClipboardStore(factory);
    const g = await tabA.generation();
    await tabA.enqueue(q('u1', 'queued', 1), g);
    await tabA.replace('u1', [ev('queued', 4), ev('kept', 5)], 5, g);
    expect(await tabB.pendingState('u1', 'queued')).toEqual({ queued: true, deleted: false });
    const del = { userId: 'u1', event_id: 'queued', at: 100, due: 100 };
    expect(await tabA.markDeleted('u1', [del], g)).toBe(true);
    // The other tab sees it gone from the queue and marked as deleted.
    expect(await tabB.pendingState('u1', 'queued')).toEqual({ queued: false, deleted: true });
    expect(await tabB.queue('u1')).toEqual([]);
    expect((await tabB.events('u1')).map((e) => e.event_id)).toEqual(['kept']);
    expect(await tabB.deletes('u1')).toEqual([del]);
    expect(await tabB.deletes('u2')).toEqual([]);
    // Updating it (a new due time) keeps one record.
    await tabA.markDeleted('u1', [{ ...del, due: 500 }], g);
    expect(await tabB.deletes('u1')).toEqual([{ ...del, due: 500 }]);
    expect(await tabA.forgetDelete('u1', 'queued', g)).toBe(true);
    expect(await tabB.deletes('u1')).toEqual([]);
    // After a wipe, a runtime started before it can neither add nor forget one; the wipe erased them all.
    await tabA.markDeleted('u1', [del], g);
    await tabB.wipe();
    expect(await tabB.deletes('u1')).toEqual([]);
    expect(await tabA.markDeleted('u1', [del], g)).toBe(false);
    expect(await tabA.forgetDelete('u1', 'queued', g)).toBe(false);
    expect(await tabB.deletes('u1')).toEqual([]);
  });

  it('ackCreate: one transaction decides from the shared queue, pending deletes and cursor whether the row is cached', async () => {
    const factory = new IDBFactory();
    const tabA = openClipboardStore(factory);
    const tabB = openClipboardStore(factory);
    const g = await tabA.generation();
    await tabA.replace('u1', [ev('cached', 2)], 3, g);
    for (const id of ['beyond', 'passed', 'cached', 'taken', 'deleted']) await tabA.enqueue(q('u1', id, 1), g);
    // Its seq is beyond the shared cursor: dequeued and cached (a later tombstone has a higher seq, pulled later).
    expect(await tabA.ackCreate('u1', ev('beyond', 4), g)).toBe('live');
    // The shared cursor already passed its seq and it is not cached: another tab pulled its tombstone.
    expect(await tabA.ackCreate('u1', ev('passed', 3), g)).toBe('gone');
    expect(await tabA.ackCreate('u1', ev('cached', 2), g)).toBe('live');
    // Another tab took it out of the queue, or deleted it: nothing written.
    await tabB.dequeue('u1', 'taken', g);
    expect(await tabA.ackCreate('u1', ev('taken', 5), g)).toBe('taken');
    await tabB.markDeleted('u1', [{ userId: 'u1', event_id: 'deleted', at: 1, due: 1 }], g);
    expect(await tabA.ackCreate('u1', ev('deleted', 6), g)).toBe('deleted');
    const snap = await tabB.snapshot('u1');
    expect(snap.events.map((e) => e.event_id).sort()).toEqual(['beyond', 'cached']);
    expect(snap.queue).toEqual([]);
    expect(snap.cursor).toBe(3);
    expect(snap.deletes.map((d) => d.event_id)).toEqual(['deleted']);
  });

  it('leaving the account (wipeAccountData) erases the clipboard cache, queue and cursor too', async () => {
    const s = clipboardStore();
    const g = await s.generation();
    await s.replace('u1', [ev('a', 1)], 1, g);
    await s.enqueue(q('u1', 'pending', 1), g);
    await wipeAccountData();
    expect(await s.events('u1')).toEqual([]);
    expect(await s.queue('u1')).toEqual([]);
    expect(await s.cursor('u1')).toBeNull();
    expect(await s.generation()).not.toBe(g);
  });
});
