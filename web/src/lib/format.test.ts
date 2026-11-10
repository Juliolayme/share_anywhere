import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it('writes seconds, minutes and seconds, or hours and minutes', () => {
    expect(formatDuration(2_000, 'en')).toBe('2 sec');
    expect(formatDuration(372_000, 'en')).toBe('6 min 12 sec');
    expect(formatDuration(3_900_000, 'en')).toBe('1 hr 5 min');
    expect(formatDuration(7_200_000, 'en')).toBe('2 hr');
    expect(formatDuration(-5, 'en')).toBe('0 sec');
  });

  it('uses the locale’s unit names', () => {
    expect(formatDuration(372_000, 'vi')).toMatch(/^6 .+ 12 .+$/);
  });
});
