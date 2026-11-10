import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/i18n';
import { ExpiryAnnouncer, crossedThreshold } from './ExpiryAnnouncer';

describe('crossedThreshold', () => {
  it('fires once per threshold, even when ticks are skipped', () => {
    expect(crossedThreshold(61, 60)).toBe(60);
    expect(crossedThreshold(63, 58)).toBe(60); // throttled timer jumped past 1:00
    expect(crossedThreshold(60, 59)).toBeNull();
    expect(crossedThreshold(31, 30)).toBe(30);
    expect(crossedThreshold(65, 25)).toBe(30); // both passed: announce the latest one
    expect(crossedThreshold(30, 0)).toBeNull();
    expect(crossedThreshold(600, 599)).toBeNull();
  });
});

describe('ExpiryAnnouncer', () => {
  const ui = (left: number) => (
    <I18nProvider initial="en">
      <ExpiryAnnouncer left={left} />
    </I18nProvider>
  );
  it('announces at 1:00 and 0:30 only, and clears for a new window', () => {
    const { rerender } = render(ui(62));
    const region = screen.getByTestId('expiry-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
    rerender(ui(58));
    expect(region).toHaveTextContent('1:00');
    rerender(ui(45));
    expect(region).toHaveTextContent('1:00');
    rerender(ui(29));
    expect(region).toHaveTextContent('0:30');
    rerender(ui(600));
    expect(region).toHaveTextContent('');
  });
});
