import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/i18n';
import { RouteChip } from './ui';

const chip = (route: 'direct' | 'relay' | null) =>
  render(
    <I18nProvider initial="en">
      <RouteChip route={route} />
    </I18nProvider>,
  );

describe('RouteChip', () => {
  it('shows Direct in green and Relay in blue, with text (Design System route badge)', () => {
    const first = chip('direct');
    const direct = screen.getByTestId('route-chip');
    expect(direct).toHaveTextContent('Connected directly');
    expect(direct.className).toContain('bg-receive-soft');
    first.unmount();
    const second = chip('relay');
    const relay = screen.getByTestId('route-chip');
    expect(relay).toHaveTextContent('Using relay');
    expect(relay.className).toContain('bg-send-soft');
    expect(relay.className).toContain('h-[26px]');
    second.unmount();
  });

  it('renders nothing while the route is unknown (connecting or reconnecting)', () => {
    const { container, unmount } = chip(null);
    expect(container.querySelector('[data-testid="route-chip"]')).toBeNull();
    unmount();
  });
});
