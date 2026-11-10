import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { fakeClient, renderApp } from '../test/render';
import { writePref } from '../lib/storage';
import { parseShareLink } from './ReceiveEntry';

describe('receive (RX-1) code entry', () => {
  it('validates an incomplete code on blur and on Continue, and supports paste', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/receive' });
    const first = await screen.findByLabelText('Digit 1 of 6');
    expect(document.querySelector('[data-screen="receive"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open link' })).toBeInTheDocument();
    await userEvent.type(first, '4');
    await userEvent.click(document.body);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter all 6 digits.');
    fireEvent.paste(first, { clipboardData: { getData: () => '48 29 13' } });
    expect((screen.getByLabelText('Digit 6 of 6') as HTMLInputElement).value).toBe('3');
    expect(screen.queryByText('Enter all 6 digits.')).toBeNull();
    await userEvent.type(screen.getByLabelText('Digit 4 of 6'), 'x');
    expect((screen.getByLabelText('Digit 4 of 6') as HTMLInputElement).value).toBe('9');
  });

  it('accepts only same-origin /j/<token> links with a long token', () => {
    const o = 'https://app.example';
    expect(parseShareLink('https://app.example/j/AbCdEfGhIjKlMnOpQrStUv', o)).toBe('AbCdEfGhIjKlMnOpQrStUv');
    expect(parseShareLink('https://evil.example/j/AbCdEfGhIjKlMnOpQrStUv', o)).toBeNull();
    expect(parseShareLink('https://app.example/j/482913', o)).toBeNull();
    expect(parseShareLink('not a url', o)).toBeNull();
  });
});

describe('send (TR-2/TR-3) picker', () => {
  it('lists picked files with the total and offers Create with Require approval', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/send' });
    const input = await screen.findByTestId('file-input');
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    await userEvent.upload(input, file);
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create share session/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Require approval' })).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByText('notes.txt')).toBeNull();
  });
});

describe('devices (DV-1)', () => {
  it('renames this device', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/devices' });
    await waitFor(() => expect(screen.getByTestId('device-name')).toHaveTextContent('Calm Otter'));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Device name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Kitchen PC{enter}');
    await waitFor(() => expect(screen.getByTestId('device-name')).toHaveTextContent('Kitchen PC'));
    expect(await screen.findByText('Device renamed')).toBeInTheDocument();
  });
});

describe('home (TR-1) identity failures', () => {
  it('shows the rate-limit wait and a retry on Transfer home', async () => {
    writePref('welcomed', '1');
    const limited = new Response(JSON.stringify({ error: 'rate_limited', retry_after_s: 125 }), {
      status: 429,
      headers: { 'Retry-After': '125' },
    });
    renderApp(<App />, { client: fakeClient({ failWith: limited }) });
    expect(
      await screen.findByText(/Too many attempts. Try again in 2:0[3-5]/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in/ })).toBeDisabled();
  });
});

describe('theme', () => {
  it('header toggle and Settings stay in sync', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/settings' });
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    const toggle = screen.getByRole('button', { name: 'Theme' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(toggle);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('share link validation', () => {
  it('validates the pasted link on blur', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/receive' });
    const input = await screen.findByLabelText('Or paste a share link');
    await userEvent.type(input, 'https://example.com/x');
    await userEvent.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('That doesn’t look like a Share Anywhere link.');
  });
});
