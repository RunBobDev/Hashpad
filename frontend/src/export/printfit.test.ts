// @vitest-environment jsdom
/**
 * jsdom has no layout, so each box's widths are given by hand: the question
 * here is the arithmetic and the clean-up, and the real exe answers whether
 * the equation then prints whole (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import { MATH_DISPLAY_CLASS } from '../preview/rules/math';
import { fitWideMath, PX_PER_MM } from './printfit';

function equation(root: HTMLElement, room: number, needed: number): HTMLElement {
  const box = document.createElement('div');
  box.className = MATH_DISPLAY_CLASS;
  const content = document.createElement('span');
  box.append(content);
  Object.defineProperty(box, 'clientWidth', { value: room });
  Object.defineProperty(box, 'scrollWidth', { value: needed });
  root.append(box);
  return content;
}

describe('fitWideMath', () => {
  it('shrinks an equation wider than the page to the page', () => {
    const root = document.createElement('div');
    const wide = equation(root, 600, 900);

    fitWideMath(root, 178);

    expect(wide.style.fontSize).toBe(`${(600 / 900) * 100}%`);
  });

  it('leaves an equation that fits alone', () => {
    const root = document.createElement('div');
    const narrow = equation(root, 600, 600);

    fitWideMath(root, 178);

    expect(narrow.style.fontSize).toBe('');
  });

  it('clears an earlier fit before measuring again', () => {
    const root = document.createElement('div');
    const content = equation(root, 600, 600);
    content.style.fontSize = '50%';

    fitWideMath(root, 178);

    expect(content.style.fontSize).toBe('');
  });

  it('measures at the printable width and puts the copy back as it was', () => {
    const root = document.createElement('div');
    root.style.width = '800px';
    let measuredAt = '';
    const box = document.createElement('div');
    box.className = MATH_DISPLAY_CLASS;
    box.append(document.createElement('span'));
    Object.defineProperty(box, 'clientWidth', {
      get: () => {
        measuredAt = root.style.width;
        return 1;
      },
    });
    Object.defineProperty(box, 'scrollWidth', { value: 1 });
    root.append(box);

    fitWideMath(root, 178);

    expect(measuredAt).toBe(`${178 * PX_PER_MM}px`);
    expect(root.style.width).toBe('800px');
  });
});
