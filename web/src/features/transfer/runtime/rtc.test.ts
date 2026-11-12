import { describe, expect, it } from 'vitest';
import { urisForStep } from './rtc';

const ALL = [
  'turn:t.example:3478?transport=udp',
  'turn:t.example:3478?transport=tcp',
  'turns:t.example:443?transport=tcp',
];

describe('urisForStep', () => {
  it('keeps every URI on the first step', () => expect(urisForStep(ALL, 'all')).toEqual(ALL));
  it('uses only UDP TURN on relay-udp', () =>
    expect(urisForStep(ALL, 'relay-udp')).toEqual(['turn:t.example:3478?transport=udp']));
  it('uses only TLS on relay-tls when a turns: URI exists', () =>
    expect(urisForStep(ALL, 'relay-tls')).toEqual(['turns:t.example:443?transport=tcp']));
  it('falls back to TCP on relay-tls without TLS', () =>
    expect(urisForStep(ALL.slice(0, 2), 'relay-tls')).toEqual(['turn:t.example:3478?transport=tcp']));
  it('never leaves a step without servers', () =>
    expect(urisForStep(['turns:t.example:443?transport=tcp'], 'relay-udp')).toEqual([
      'turns:t.example:443?transport=tcp',
    ]));
});
