import { render, screen } from '@testing-library/react';
import { Logo } from './Logo';
import { logo } from '../styles/tokens';

describe('Logo', () => {
  it('follows the theme by default through the logo CSS variables', () => {
    const { container } = render(<Logo lockup />);
    const rects = container.querySelectorAll('rect');
    expect(rects[0]).toHaveAttribute('fill', 'var(--sa-logo-send)');
    expect(rects[1]).toHaveAttribute('fill', 'var(--sa-logo-receive)');
    expect(screen.getByText('Share Anywhere')).toHaveStyle({ color: 'var(--sa-logo-text)' });
  });

  it('renders the two capsules and two dots in the fixed color mode', () => {
    const { container } = render(<Logo mode="color" />);
    expect(screen.getByRole('img', { name: 'Share Anywhere' })).toBeInTheDocument();
    const rects = container.querySelectorAll('rect');
    expect(rects[0]).toHaveAttribute('fill', logo.modes.color.send);
    expect(rects[1]).toHaveAttribute('fill', logo.modes.color.receive);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('uses the dotless variant at 16 px and below, as the brand guide requires', () => {
    expect(render(<Logo size={16} />).container.querySelectorAll('circle')).toHaveLength(0);
    expect(render(<Logo size={17} />).container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('renders the wordmark lockup as one labelled image', () => {
    render(<Logo lockup mode="dark" />);
    const img = screen.getByRole('img', { name: 'Share Anywhere' });
    expect(img.textContent).toContain('Share Anywhere');
    expect(img.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('is hidden from assistive technology when decorative', () => {
    const { container } = render(<Logo label="" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
