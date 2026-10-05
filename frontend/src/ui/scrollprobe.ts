/**
 * **A temporary instrument, not a feature.** It exists to answer one question
 * that three rounds of reasoning could not, and it comes out once that question
 * is answered.
 *
 * The question: the owner reports the editor scrolling choppily in source and
 * split but not in live preview. Two fixes shipped on two different theories --
 * CodeMirror's height-estimate compensation, then a non-passive `wheel`
 * listener taking the page off compositor scrolling -- and neither changed what
 * he feels. Both were reasoned from the code, because **the only browser
 * available here cannot reproduce a scrolling bug at all**: it has smooth
 * scrolling switched off, its synthetic wheel events bypass the compositor, and
 * `requestAnimationFrame` barely fires while its pane is hidden. Three
 * independent reasons, all measured.
 *
 * So the instrument has to run where the bug is. This records what choppiness
 * is actually made of, on the machine that has it:
 *
 * - **Input delay on the wheel** -- how long a tick waits before JavaScript
 *   even sees it. High here means the main thread is blocking input, which is
 *   what the passive-listener fix was meant to end.
 * - **Frame intervals** -- how long the browser took between paints. High here
 *   with low input delay means rendering is the cost, not input.
 * - **Long tasks** -- any single main-thread task over 50ms, which is the
 *   thing that produces both of the above.
 * - **Scroll deltas** -- whether the position ever moves *against* the
 *   direction of travel, which is the original report.
 *
 * Whichever of those four is bad says which half of the problem to look at,
 * and the three that are fine rule their half out. Reading all four at once is
 * the point: any one of them alone is what the last two rounds had.
 *
 * Not shipped in an ordinary build -- `main.ts` imports this dynamically, and
 * only when `VITE_SCROLL_PROBE` is set, so nothing here reaches a release
 * bundle.
 */
import { WriteFile } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import { activeDocument } from '../state/documents';
import { emitCommand } from './menubar';

/**
 * **The automated half.** The overlay needed a person to read it, and the
 * owner's time was the bottleneck -- so the probe can also be driven from
 * outside with real OS wheel input, and write a frame-by-frame trace to disk.
 *
 * The driver presses these chords, which nothing else in the app binds:
 *
 * - **Ctrl+Alt+Shift+S / L** -- switch the active document to source / live
 *   preview through the same command the View menu runs, and start a fresh
 *   trace phase named after the mode.
 * - **Ctrl+Alt+Shift+D** -- write every phase to `scroll-probe.json` beside the
 *   open document, through the app's own `WriteFile`.
 *
 * A trace rather than a summary, because the summary is what the overlay
 * already had and what could not say *why*: whether a step backwards lands on
 * the same frame as a change in the document's height is the difference
 * between CodeMirror correcting its estimates and something else entirely.
 */
type Phase = { frames: number[][]; scrolls: number[][]; wheels: number[][] };

const round = (value: number): number => Math.round(value * 10) / 10;

interface Samples {
  frames: number[];
  wheelDelay: number[];
  longTasks: number[];
  reversals: number[];
}

function fresh(): Samples {
  return { frames: [], wheelDelay: [], longTasks: [], reversals: [] };
}

/**
 * **An instrument that causes the thing it measures is worthless**, and this one
 * did on the first draft: rendering sorted every sample on every repaint, over
 * arrays that grow for as long as you scroll. A minute of scrolling is tens of
 * thousands of frames, and the sort landed on the main thread -- manufacturing
 * exactly the jank the probe exists to find.
 *
 * So samples are capped and the display is throttled. The cap is a window, not
 * a budget: percentiles over the last few thousand samples describe scrolling
 * now, which is what is being asked about, and the worst case is kept
 * separately so a spike that falls out of the window is not forgotten.
 */
const WINDOW = 2000;
const RENDER_EVERY_MS = 250;

function record(values: number[], value: number): void {
  values.push(value);
  if (values.length > WINDOW) values.shift();
}

/** `p` as a fraction, on a copy that is sorted in place. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) * 10) / 10
  );
}

function line(label: string, values: number[], unit = 'ms'): string {
  if (values.length === 0) return `${label.padEnd(9)} —`;
  return (
    `${label.padEnd(9)} n=${String(values.length).padEnd(5)}` +
    `med ${String(percentile(values, 0.5)).padEnd(7)}` +
    `p90 ${String(percentile(values, 0.9)).padEnd(7)}` +
    `worst ${percentile(values, 1)}${unit}`
  );
}

export function mountScrollProbe(): () => void {
  const scroller = document.querySelector<HTMLElement>('.cm-scroller');
  if (scroller === null) return () => {};

  let samples = fresh();
  let lastFrame = performance.now();
  let lastTop = scroller.scrollTop;
  let running = true;

  const box = document.createElement('pre');
  box.setAttribute('data-scroll-probe', '');
  box.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:99999',
    'margin:0',
    'padding:8px 10px',
    'font:11px/1.45 Consolas,monospace',
    'background:rgba(0,0,0,.86)',
    'color:#0f0',
    'border:1px solid #0f0',
    'border-radius:4px',
    'white-space:pre',
    'pointer-events:auto',
    'cursor:pointer',
    'user-select:text',
  ].join(';');
  // Not in `#app`: that subtree is rebuilt on view-mode changes, and an
  // instrument that disappears when you switch modes cannot compare modes.
  document.body.append(box);

  let worstFrame = 0;
  let worstReversal = 0;
  let slowFrames = 0;
  let lastRender = 0;

  // **The throttle needs a trailing edge**, and leaving it out was a real bug
  // rather than a rough edge: scrolling stops, the last burst of samples is
  // inside the throttle window, and the overlay keeps showing numbers from up
  // to a quarter-second before you stopped. The reading a person takes is
  // precisely the one taken after they stop scrolling.
  let pending: ReturnType<typeof setTimeout> | null = null;

  function render(force = false): void {
    const now = performance.now();
    const since = now - lastRender;
    if (!force && since < RENDER_EVERY_MS) {
      pending ??= setTimeout(() => {
        pending = null;
        render(true);
      }, RENDER_EVERY_MS - since);
      return;
    }
    lastRender = now;
    const mode = activeDocument(store.getState())?.viewMode ?? '—';
    box.textContent = [
      `SCROLL PROBE  ·  mode: ${mode}  ·  click to reset`,
      line('frames', samples.frames),
      line('wheel in', samples.wheelDelay),
      line('longtask', samples.longTasks),
      `slow       frames over 32ms: ${String(slowFrames)}   worst frame ${String(worstFrame)}ms`,
      `reversals  n=${String(samples.reversals.length)}   worst ${String(worstReversal)}px`,
    ].join('\n');
  }

  // **Driven from both clocks on purpose.** `requestAnimationFrame` is what
  // measures frames, and it is also the one thing that can stop: it does not
  // fire in a hidden window, and it was starved in the first place this probe
  // was tried. A display that only repaints from it shows a blank instrument
  // and no way to tell that apart from a quiet one. The scroll event repaints
  // it too, so the numbers move whenever the thing being measured is happening.
  const phases: Record<string, Phase> = {};
  let phase: Phase | null = null;

  const tick = (): void => {
    const now = performance.now();
    const delta = now - lastFrame;
    lastFrame = now;
    record(samples.frames, delta);
    if (delta > 32) slowFrames++;
    worstFrame = Math.max(worstFrame, Math.round(delta * 10) / 10);
    phase?.frames.push([round(now), round(scroller.scrollTop), scroller.scrollHeight]);
    render();
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const onWheel = (event: WheelEvent): void => {
    phase?.wheels.push([round(event.timeStamp), event.deltaY, event.deltaMode]);
  };
  window.addEventListener('wheel', onWheel, { passive: true });

  // **`keyCode`, deprecated or not.** Synthesised OS input (`keybd_event` with
  // no scan code) arrives with an empty `event.code`, and `event.key` under
  // Ctrl+Alt is layout-dependent -- AltGr on many European layouts. The virtual
  // key code is the one field both a real keyboard and the driver agree on.
  const S = 83;
  const L = 76;
  const P = 80;
  const R = 82;
  const D = 68;
  // Which command reaches each mode. All four are the View menu's own toggles,
  // so each is sent only when the document is not already there.
  const modes: Record<number, ['source' | 'live' | 'split' | 'preview', string]> = {
    [S]: ['source', 'view.livePreview'],
    [L]: ['live', 'view.livePreview'],
    [P]: ['split', 'view.preview'],
    [R]: ['preview', 'view.readingMode'],
  };
  const onChord = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey && event.altKey && event.shiftKey)) return;
    const mode = modes[event.keyCode];
    if (mode) {
      const [target, command] = mode;
      if (activeDocument(store.getState())?.viewMode !== target) emitCommand(command);
      phase = { frames: [], scrolls: [], wheels: [] };
      phases[target] = phase;
      onClick();
    } else if (event.keyCode === D) {
      phase = null;
      const path = activeDocument(store.getState())?.filePath;
      if (path) {
        const out = path.replace(/[^\\/]+$/, 'scroll-probe.json');
        const trace = { userAgent: navigator.userAgent, dpr: devicePixelRatio, phases };
        void WriteFile(out, JSON.stringify(trace), 'utf-8', 'lf');
      }
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // Capture, so the chord is seen before CodeMirror's keymap can claim it.
  window.addEventListener('keydown', onChord, true);

  // Against the direction of travel, which is the original report: "scrolling
  // down it jumps a tiny bit up". Sign, not magnitude, is what makes it one.
  //
  // **A counter-move does not become the new direction of travel**, and getting
  // that wrong doubled every count: the blip registered as one reversal, and
  // the resumption of normal scrolling registered as a second, because the
  // direction had been flipped by the blip. One stutter is one stutter. The
  // travel direction only changes when the scroll actually keeps going that
  // way, which is what `lastDirection` now holds.
  let lastDirection = 0;
  const onScroll = (event: Event): void => {
    const top = scroller.scrollTop;
    phase?.scrolls.push([round(event.timeStamp), round(top)]);
    const delta = top - lastTop;
    if (delta !== 0) {
      if (lastDirection !== 0 && Math.sign(delta) !== lastDirection) {
        const size = Math.round(Math.abs(delta));
        record(samples.reversals, size);
        worstReversal = Math.max(worstReversal, size);
      } else {
        lastDirection = Math.sign(delta);
      }
      lastTop = top;
    }
    render();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  // `processingStart - startTime` is the wait before any JavaScript ran, which
  // is exactly what a non-passive listener or a busy main thread adds.
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, take: (entry: PerformanceEntry) => void): void => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) take(entry);
      });
      // `durationThreshold` is ignored by observers that do not know it.
      observer.observe({ type, buffered: true, durationThreshold: 0 } as PerformanceObserverInit);
      observers.push(observer);
    } catch {
      // An engine without this entry type reports nothing rather than failing
      // the probe; the line renders as `—` and the other three still answer.
    }
  };
  observe('event', (entry) => {
    if (entry.name !== 'wheel') return;
    const timing = entry as PerformanceEventTiming;
    record(samples.wheelDelay, Math.round((timing.processingStart - timing.startTime) * 10) / 10);
    render();
  });
  observe('longtask', (entry) => {
    record(samples.longTasks, Math.round(entry.duration * 10) / 10);
    render();
  });

  const onClick = (): void => {
    samples = fresh();
    lastDirection = 0;
    worstFrame = 0;
    worstReversal = 0;
    slowFrames = 0;
    render(true);
  };
  box.addEventListener('click', onClick);

  render(true);
  return () => {
    running = false;
    if (pending !== null) clearTimeout(pending);
    scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onChord, true);
    box.removeEventListener('click', onClick);
    for (const observer of observers) observer.disconnect();
    box.remove();
  };
}
