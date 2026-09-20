// @vitest-environment jsdom
/**
 * **The probe is the thing being trusted next, so it gets checked first.**
 *
 * Two instruments in this investigation have now produced confident readings
 * that did not survive re-measurement -- one counted `scrollTop` reversals that
 * CodeMirror writes deliberately and a person cannot see, one ran past the end
 * of the document. Both times the *diagnosis* was wrong because the measurement
 * was. Handing over a third unverified instrument would be the same mistake a
 * third time.
 *
 * What cannot be checked here is the half that depends on a real browser:
 * `requestAnimationFrame` intervals, `PerformanceObserver` entries for wheel
 * input delay and long tasks. jsdom has no frames and no input. What *can* be
 * checked is the half that is arithmetic -- reversal detection, the sample
 * window, and reset -- which is exactly the half that can be silently wrong
 * while still rendering plausible numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountScrollProbe } from './scrollprobe';

let scroller: HTMLElement;
let stop: () => void;

function scrollTo(top: number): void {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
}

/**
 * Remounts with the scroller already at `top`.
 *
 * Needed for the upward cases, and the reason is worth stating: the probe
 * learns the direction of travel from the movements it sees. A test that
 * mounts at 0 and then asks for an upward scroll has to travel *down* to get
 * anywhere first, and that first jump is a real direction change -- the probe
 * would be right to count what follows, and the test would be measuring its
 * own setup.
 */
function restartAt(top: number): void {
  stop();
  scroller.scrollTop = top;
  stop = mountScrollProbe();
}

/**
 * The overlay's text, which is the whole of what a person reads off it.
 *
 * Awaited, because the display is throttled: the reading that matters is the
 * one taken after scrolling stops, and that arrives on the throttle's trailing
 * edge rather than with the last event.
 */
async function readout(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return document.querySelector('[data-scroll-probe]')?.textContent ?? '';
}

/** `reversals  n=3   worst 14px` -> `[3, 14]`. */
async function reversals(): Promise<[number, number]> {
  const text = await readout();
  const match = /reversals\s+n=(\d+)\s+worst (\d+)px/.exec(text);
  expect(match, `no reversals line in:\n${text}`).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

beforeEach(() => {
  scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  document.body.append(scroller);
  stop = mountScrollProbe();
});

afterEach(() => {
  stop();
  scroller.remove();
});

describe('mountScrollProbe', () => {
  it('mounts an overlay outside the app subtree', async () => {
    const box = document.querySelector('[data-scroll-probe]');
    expect(box).not.toBeNull();
    // `#app` is rebuilt on a view-mode change, and comparing modes is the
    // entire purpose -- an instrument that unmounts on the switch is useless.
    expect(box!.closest('#app')).toBeNull();
    expect(await readout()).toContain('SCROLL PROBE');
  });

  it('counts no reversal while the scroll only goes one way', async () => {
    for (let top = 100; top <= 1000; top += 100) scrollTo(top);
    expect(await reversals()).toEqual([0, 0]);
  });

  it('counts no reversal while the scroll only goes the other way', async () => {
    restartAt(1000);
    for (let top = 900; top >= 100; top -= 100) scrollTo(top);
    expect(await reversals()).toEqual([0, 0]);
  });

  /**
   * The reported symptom exactly: travelling down, and a step that goes up.
   *
   * Two directions are asserted rather than one because the report named both
   * ("when I scroll up every few ticks it scrolls a tiny bit down"), and a
   * sign error would pass the down case alone.
   */
  it.each([
    ['downwards', 0, [100, 200, 300, 286, 400, 500], 14],
    ['upwards', 1000, [900, 800, 811, 700, 600], 11],
  ])(
    'counts one reversal, not two, for a step against the direction of travel, %s',
    async (_label, from, steps, worst) => {
      restartAt(from);
      for (const top of steps) scrollTo(top);
      // One, not two: resuming normal scrolling after the blip is not a second
      // stutter, and counting it as one doubled every reading.
      expect(await reversals()).toEqual([1, worst]);
    },
  );

  it('keeps the worst reversal even after later smaller ones', async () => {
    scrollTo(1000);
    scrollTo(960); // up 40 -- a reversal of 40
    scrollTo(1100);
    scrollTo(1095); // up 5
    scrollTo(1200);
    expect(await reversals()).toEqual([2, 40]);
  });

  /**
   * A scroll event that does not move the scroller is not a reversal, and this
   * is not hypothetical: CodeMirror's own `scrollTop` writes fire events that
   * land on the same value, and a probe that counted those would report drift
   * on a document that never moved.
   */
  it('ignores a scroll event that changed nothing', async () => {
    scrollTo(100);
    scrollTo(200);
    scrollTo(200);
    scrollTo(300);
    expect(await reversals()).toEqual([0, 0]);
  });

  it('clears everything on click, so each mode can be measured on its own', async () => {
    scrollTo(100);
    scrollTo(200);
    scrollTo(150);
    expect((await reversals())[0]).toBe(1);

    document.querySelector<HTMLElement>('[data-scroll-probe]')!.click();
    expect(await reversals()).toEqual([0, 0]);
  });

  /**
   * **With no frames at all, the readout must still arrive.**
   *
   * `requestAnimationFrame` drives the repaint as well as the frame
   * measurement, and it is the one clock that can stop: it does not fire in a
   * hidden window, and it was starved in the browser this probe was first tried
   * in, which is what made it render a blank instrument. So the scroll path has
   * to be able to deliver a reading on its own.
   *
   * This is the only test that covers the throttle's trailing edge. Every other
   * one passes with it removed, because jsdom *does* run frames and the next
   * tick repaints -- exactly the false comfort that makes this control
   * necessary. Deleting the trailing render makes this case, and only this
   * case, fail.
   */
  it('still reports after scrolling stops when no frames are running', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    try {
      restartAt(0);
      scrollTo(100);
      scrollTo(200);
      scrollTo(186);
      expect(await reversals()).toEqual([1, 14]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops measuring once torn down', () => {
    stop();
    expect(document.querySelector('[data-scroll-probe]')).toBeNull();
    // Would throw if the listener outlived the overlay it writes into.
    scrollTo(100);
    scrollTo(50);
    stop = () => {};
  });
});
