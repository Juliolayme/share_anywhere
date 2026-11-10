import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BrandPreview from './BrandPreview';
import { colorTokens, typeScale } from '../styles/tokens';

describe('BrandPreview', () => {
  it('renders a swatch for every color token and both theme panels', () => {
    render(<BrandPreview />);
    for (const name of colorTokens) expect(screen.getByTestId(`swatch-${name}`)).toBeInTheDocument();
    expect(screen.getByTestId('panel-light')).toBeInTheDocument();
    expect(screen.getByTestId('panel-dark')).toBeInTheDocument();
  });

  it('renders the four logo lockups and every type style', () => {
    render(<BrandPreview />);
    for (const mode of ['color', 'dark', 'mono-dark', 'mono-light']) {
      expect(screen.getByTestId(`lockup-${mode}`)).toBeInTheDocument();
    }
    for (const name of Object.keys(typeScale)) expect(screen.getByTestId(`type-${name}`)).toBeInTheDocument();
  });

  it('switches the document theme from the radio group', async () => {
    const user = userEvent.setup();
    render(<BrandPreview />);
    await user.click(screen.getByLabelText('Dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await user.click(screen.getByLabelText('Light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.click(screen.getByLabelText('System'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
