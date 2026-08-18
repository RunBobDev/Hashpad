// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mountZoom, zoomIn, zoomLevel, zoomOut, zoomReset } from './zoom';

function cssZoom(): string {
  return document.documentElement.style.getPropertyValue('--zoom');
}

beforeEach(() => {
  zoomReset();
});

describe('zoom', () => {
  it('writes the factor to the document, not just to a variable', () => {
    zoomIn();
    expect(zoomLevel()).toBeGreaterThan(1);
    // The CSS custom property is the entire mechanism -- a level nothing wrote
    // out is a level nothing renders.
    expect(Number(cssZoom())).toBeCloseTo(zoomLevel(), 5);
  });

  it('steps up and back down to where it started', () => {
    zoomIn();
    zoomOut();
    expect(zoomLevel()).toBeCloseTo(1, 5);
  });

  // Repeated multiply/divide by 1.1 drifts; rounding is what keeps Ctrl+0
  // unnecessary after a round trip.
  it('does not drift over many steps', () => {
    for (let i = 0; i < 8; i++) zoomIn();
    for (let i = 0; i < 8; i++) zoomOut();
    expect(zoomLevel()).toBe(1);
  });

  it('clamps rather than running away in either direction', () => {
    for (let i = 0; i < 60; i++) zoomIn();
    expect(zoomLevel()).toBeLessThanOrEqual(3);
    for (let i = 0; i < 120; i++) zoomOut();
    expect(zoomLevel()).toBeGreaterThanOrEqual(0.5);
  });

  it('resets to exactly 1', () => {
    zoomIn();
    zoomIn();
    zoomReset();
    expect(zoomLevel()).toBe(1);
    expect(Number(cssZoom())).toBe(1);
  });
});

describe('mountZoom', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = mountZoom(window);
  });
  afterEach(() => {
    teardown();
  });

  function press(key: string, ctrlKey = true): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, ctrlKey, cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    return event;
  }

  // `=` as well as `+`: the plus on the main row needs Shift, which is why every
  // browser treats the unshifted key as zoom-in.
  it.each(['+', '='])('zooms in on Ctrl+%s', (key) => {
    const event = press(key);
    expect(zoomLevel()).toBeGreaterThan(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('zooms out on Ctrl+Minus and resets on Ctrl+0', () => {
    press('-');
    expect(zoomLevel()).toBeLessThan(1);
    press('0');
    expect(zoomLevel()).toBe(1);
  });

  it('ignores the same keys without Ctrl', () => {
    const event = press('=', false);
    expect(zoomLevel()).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  // Ctrl+Alt+Minus is an em-dash on some layouts, not a zoom request.
  it('ignores Ctrl+Alt combinations', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, altKey: true }));
    expect(zoomLevel()).toBe(1);
  });

  it('leaves other Ctrl shortcuts alone', () => {
    const event = press('s');
    expect(event.defaultPrevented).toBe(false);
  });

  function wheel(deltaY: number, ctrlKey = true): WheelEvent {
    const event = new WheelEvent('wheel', { deltaY, ctrlKey, cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    return event;
  }

  /**
   * `preventDefault` matters more here than the zoom does: without it WebView2
   * runs its own page zoom on top of ours, which scales the chrome -- the one
   * thing SPEC §6.6 rules out.
   */
  it('zooms on Ctrl+scroll and prevents the browser doing it too', () => {
    const up = wheel(-100);
    expect(zoomLevel()).toBeGreaterThan(1);
    expect(up.defaultPrevented).toBe(true);

    wheel(100);
    expect(zoomLevel()).toBeCloseTo(1, 5);
  });

  it('leaves an ordinary scroll alone', () => {
    const event = wheel(-100, false);
    expect(zoomLevel()).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once torn down', () => {
    teardown();
    press('=');
    wheel(-100);
    expect(zoomLevel()).toBe(1);
    teardown = () => {};
  });
});

/**
 * "Zooms editor and preview content only, never the UI chrome" (SPEC §6.6) is
 * a property of which tokens multiply by `--zoom`, so it is checked where that
 * is decided rather than by trying to observe a font size jsdom cannot compute.
 */
describe('variables.css', () => {
  const CSS = readFileSync('src/styles/variables.css', 'utf8');

  function declaration(name: string): string {
    return new RegExp(`--${name}:([^;]*);`).exec(CSS)?.[1]?.trim() ?? '';
  }

  it.each(['size-editor', 'size-preview'])('scales --%s by --zoom', (token) => {
    expect(declaration(token)).toContain('var(--zoom)');
  });

  it('leaves --size-ui unscaled, so the chrome never zooms', () => {
    expect(declaration('size-ui')).not.toContain('var(--zoom)');
    // Guard: a typo in the token name would make the assertion above vacuous.
    expect(declaration('size-ui')).not.toBe('');
  });
});
