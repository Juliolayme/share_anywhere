import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { fakeClient, renderApp } from '../test/render';
import { writePref } from '../lib/storage';
import { parseShareLink } from './ReceiveEntry';

describe('receive code entry', () => {
  it('validates six digits, supports paste, and keeps the join action hidden', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/receive' });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter all 6 digits.');
    const first = screen.getByLabelText('Digit 1 of 6');
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

describe('send picker', () => {
  it('lists picked files with the total and hides Create while sharing is off', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/send' });
    const input = await screen.findByTestId('file-input');
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    await userEvent.upload(input, file);
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create share session/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByText('notes.txt')).toBeNull();
  });
});

describe('devices', () => {
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

describe('identity failures', () => {
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
