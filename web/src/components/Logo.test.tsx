import { render, screen } from '@testing-library/react';
import { Logo } from './Logo';
import { logo } from '../styles/tokens';

describe('Logo', () => {
  it('renders the two capsules and two dots in the color mode by default', () => {
    const { container } = render(<Logo />);
    expect(screen.getByRole('img', { name: 'Share Anywhere' })).toBeInTheDocument();
    const rects = container.querySelectorAll('rect');
    expect(rects[0]).toHaveAttribute('fill', logo.modes.color.send);
    expect(rects[1]).toHaveAttribute('fill', logo.modes.color.receive);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('drops the dots below 16 px as the brand guide requires', () => {
    const { container } = render(<Logo size={12} />);
    expect(container.querySelectorAll('circle')).toHaveLength(0);
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
