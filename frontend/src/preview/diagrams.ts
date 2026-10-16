/**
 * Mermaid diagrams, loaded on demand and drawn *after* sanitisation (SPEC §7.2).
 *
 * The same arrangement as `math.ts`, for the same reason (design §4.29): a
 * Mermaid SVG carries a `<style>` element and inline styles, both of which
 * `render.ts`'s sanitiser strips, so a diagram routed through it would arrive
 * as a shapeless pile rather than as an error.
 *
 * **Where this differs from math, and it is the whole of L.2: Mermaid is
 * asynchronous even once it has loaded.** `mermaid.render` measures laid-out
 * text to size its nodes, so it returns a promise by design. KaTeX hands back a
 * string and `math.ts` can fill a placeholder the instant the chunk arrives;
 * nothing here can. Three things follow, and none of them is optional:
 *
 * - **A cache keyed on the diagram's source**, because `pane.ts` replaces the
 *   whole pane's HTML on a 150 ms debounce. Without one, every keystroke
 *   anywhere in the document would re-run Mermaid on every diagram in it.
 * - **`isConnected` before writing**, because a render that started two
 *   keystrokes ago finishes against a pane that has since been rebuilt. The
 *   element it was given is detached by then, and writing to it is invisible;
 *   the danger is writing to the *wrong* element, which is what a cruder
 *   generation counter would have to work to avoid.
 * - **Errors caught per diagram**, because `pane.ts` answers a thrown renderer
 *   by replacing the whole pane with an error card. One mistyped arrow must not
 *   blank the document around it -- and a diagram is mistyped for most of the
 *   time it is being written.
 *
 * **Mermaid cannot be tested in jsdom at all.** `mermaid.render` calls `getBBox`
 * on an SVG node, which jsdom does not implement, so it throws before doing
 * anything. `diagrams.test.ts` covers the placeholder, the cache and the
 * connected check with a stub renderer; whether a diagram actually *draws* is
 * `harness/diagrams.html`'s question and cannot be answered anywhere else.
 */
import { DIAGRAM_CLASS } from './rules/mermaid';

type Mermaid = typeof import('mermaid').default;

let mermaid: Mermaid | null = null;
/** The load in flight or done; `null` before the first request and after a failure. */
let loading: Promise<void> | null = null;
/**
 * The two Mermaid themes this app uses, narrowed from the eleven it offers --
 * `initialize` types `theme` as a union, so a bare `string` does not compile.
 * One for each of ours; the other nine are opinions about colour that
 * `variables.css` already has.
 */
type MermaidTheme = 'default' | 'dark';

/**
 * OLED black's corrections to Mermaid's dark theme (design §4.36). Its pie
 * draws outlines in pure black and two of its slice colours are near-black, all
 * of which vanish on `#000`. The tokens exist only in variables.css's OLED
 * block, so Dark keeps Mermaid's own colours.
 */
const OLED_PIE = [
  ['pieStrokeColor', '--diagram-pie-stroke'],
  ['pieOuterStrokeColor', '--diagram-pie-stroke'],
  ['pie1', '--diagram-pie-1'],
  ['pie9', '--diagram-pie-9'],
] as const;

/** What Mermaid's theme is given on top of its own; empty except in OLED black. */
function themeVariables(theme: MermaidTheme): Record<string, string> {
  const variables: Record<string, string> = {};
  // Light, which exports always draw in, even from an OLED window.
  if (theme !== 'dark') return variables;
  const css = getComputedStyle(document.documentElement);
  for (const [name, token] of OLED_PIE) {
    const value = css.getPropertyValue(token).trim();
    if (value !== '') variables[name] = value;
  }
  return variables;
}

/**
 * One string per distinct look, for the cache key and `initialisedFor`. JSON
 * is self-delimiting, so the key's `:` before the source stays unambiguous.
 */
function lookOf(theme: MermaidTheme, variables: Record<string, string>): string {
  return Object.keys(variables).length === 0 ? theme : `${theme}${JSON.stringify(variables)}`;
}

/** The look (theme and variables) Mermaid was last initialised with; `null` until it has been. */
let initialisedFor: string | null = null;
const listeners = new Set<() => void>();

/**
 * Rendered SVG, keyed on theme and source together.
 *
 * Theme is part of the key rather than a reason to clear the cache: Mermaid
 * bakes its colours into the SVG, so the same diagram is two different
 * renderings and there is no sense in which one supersedes the other. Flipping
 * the theme twice then costs nothing.
 *
 * The two halves are joined with a `:`, which neither theme name contains. An
 * earlier version used a literal NUL, which worked and made the whole file read
 * as binary to `grep` and every other line-oriented tool.
 */
const cache = new Map<string, string>();

/** Bounded so a long session editing diagrams cannot grow it without limit. */
const CACHE_LIMIT = 64;

/** `mermaid.render` needs an id per call, and a repeat can collide. */
let nextId = 0;

/** Marks a placeholder as drawn, so a second pass over the same DOM is a no-op. */
const DONE = 'preview-mermaid-done';

const SELECTOR = `.${DIAGRAM_CLASS}:not(.${DONE})`;

/** Told when Mermaid arrives, so the pane can render again with diagrams. */
export function onDiagramsLoaded(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function remember(key: string, svg: string): void {
  // Oldest out first. `Map` iterates in insertion order, so the first key is
  // the least recently *added* -- not the least recently used, which would need
  // a re-insert on every hit for a bound nobody will reach.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, svg);
}

/**
 * What a failed diagram looks like: the message, and the source that produced
 * it, in place of the picture.
 *
 * Built as DOM rather than as an HTML string because the message comes from
 * Mermaid and the source comes from the document, and neither is ours to trust
 * with `innerHTML`.
 */
function failure(message: string, source: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'preview-mermaid-error';

  const heading = document.createElement('strong');
  heading.textContent = 'Diagram error';
  box.append(heading);

  const detail = document.createElement('div');
  detail.className = 'preview-mermaid-error__message';
  detail.textContent = message;
  box.append(detail);

  const code = document.createElement('pre');
  code.textContent = source;
  box.append(code);
  return box;
}

/**
 * Mermaid appends temporary elements to `document.body` while it measures, and
 * **does not take them away when a render fails.**
 *
 * Measured in the harness, which is the only place it can be: with this
 * disabled, three renders of a document containing one broken diagram left six
 * nodes on `body` -- a `<div id="d…">` and an `<svg id="…">` per failure. A
 * diagram is broken for most of the time it is being written, and the pane
 * re-renders every 150 ms, so that is a leak measured in nodes per keystroke.
 */
function sweep(id: string): void {
  for (const leftover of document.querySelectorAll(`#${id}, #d${id}`)) leftover.remove();
}

/**
 * Draws run one at a time. Mermaid's theme is global -- `initialize` sets it
 * for whatever renders next -- and an export draws light while a dark pane can
 * be drawing too. Interleaved, one diagram would come out in the other's
 * colours.
 */
let queue: Promise<unknown> = Promise.resolve();

function draw(
  source: string,
  theme: MermaidTheme,
  variables: Record<string, string>,
): Promise<string> {
  const turn = queue.then(() => drawNow(source, theme, variables));
  queue = turn.catch(() => undefined);
  return turn;
}

async function drawNow(
  source: string,
  theme: MermaidTheme,
  variables: Record<string, string>,
): Promise<string> {
  const module = mermaid;
  if (module === null) throw new Error('mermaid not loaded');

  // Re-initialised only when the look actually changes. `initialize` is not
  // free and the pane calls this on every render.
  const look = lookOf(theme, variables);
  if (initialisedFor !== look) {
    module.initialize({
      startOnLoad: false,
      // **The security half of drawing past the sanitiser** (design §4.29).
      // Strict mode runs Mermaid's own DOMPurify over every label, which is
      // what stands between a document's diagram text and the pane. Asserted in
      // the harness rather than here, because none of this runs under jsdom.
      securityLevel: 'strict',
      // **And strict mode alone was not enough.** Measured in the harness: a
      // label of `<img src=x onerror=alert(1)>` came through as a live `<img>`
      // with the handler stripped but the tag and `src` intact, rendered into a
      // `<foreignObject>`. Not an execution hole -- the handler was gone and the
      // CSP's `img-src 'self'` would refuse a remote source -- but a document
      // should not be able to put an image into the pane through a diagram
      // label at all.
      //
      // Turning HTML labels off renders them as SVG `<text>` instead, which
      // removes the entire surface rather than trusting a sanitiser to keep
      // emptying it. `<br>` still breaks a line; Mermaid splits those into
      // tspans itself.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme,
      // Always passed, empty or not: each `initialize` rebuilds the theme from
      // these, so OLED's colours cannot outlive a switch back to Dark.
      themeVariables: variables,
    });
    initialisedFor = look;
  }

  const id = `hashpad-mermaid-${String(nextId++)}`;
  try {
    const { svg } = await module.render(id, source);
    return svg;
  } finally {
    sweep(id);
  }
}

/**
 * Mermaid, as a promise -- what an export waits on, where the pane only needs
 * the load started. Same shape as `math.ts`'s `loadMath`.
 */
export function loadDiagrams(): Promise<void> {
  loading ??= import('mermaid').then(
    (module) => {
      mermaid = module.default;
      for (const listener of listeners) listener();
    },
    (error: unknown) => {
      // No permanent "requested" state pinning the feature off for the session.
      loading = null;
      throw error;
    },
  );
  return loading;
}

function load(): void {
  // Same reasoning as `math.ts`: no unhandled rejection in the webview console,
  // and no notification, because telling listeners re-renders and a re-render
  // is what retries.
  void loadDiagrams().catch(() => undefined);
}

/**
 * Draws every diagram placeholder under `root`.
 *
 * `dark` rather than a store read, so this stays testable without an app around
 * it -- `pane.ts` owns the question of which theme is current, as it owns the
 * document directory for images.
 *
 * Returns a promise for the tests' sake; `pane.ts` deliberately does not await
 * it, because a render must not block on a diagram.
 */
export async function renderDiagramsIn(root: ParentNode, dark: boolean): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>(SELECTOR)];
  // The common case: no diagrams, nothing loaded, nothing paid.
  if (nodes.length === 0) return;

  const theme: MermaidTheme = dark ? 'dark' : 'default';
  const variables = themeVariables(theme);
  const look = lookOf(theme, variables);

  // **Cache hits first, and synchronously.** This is what makes a document with
  // diagrams typeable: everything already drawn is back on screen in the same
  // turn the pane rebuilt its HTML, with no flicker and no Mermaid call.
  const misses: { node: HTMLElement; source: string; key: string }[] = [];
  for (const node of nodes) {
    const source = node.textContent ?? '';
    const key = `${look}:${source}`;
    const hit = cache.get(key);
    node.classList.add(DONE);
    if (hit === undefined) {
      misses.push({ node, source, key });
    } else {
      // **`innerHTML` with markup that has not been through our sanitiser**,
      // which is the deliberate decision design §4.29 records rather than an
      // oversight. What goes in is Mermaid's SVG, generated by a bundled
      // library from the document's *text*, with Mermaid's own strict-mode
      // DOMPurify already applied to every label. It is not the document's
      // HTML, which is what `render.ts`'s sanitiser exists to distrust.
      //
      // The contrast with `failure()` below is the point: the error message and
      // the source *are* untrusted-shaped, so they go in as `textContent`.
      node.innerHTML = hit;
    }
  }

  if (misses.length === 0) return;

  if (mermaid === null) {
    load();
    // The placeholders keep showing their source until the chunk lands and the
    // pane renders again -- the same fallback math has, and a readable one: the
    // diagram's text is what you wrote.
    for (const { node } of misses) node.classList.remove(DONE);
    return;
  }

  for (const { node, source, key } of misses) {
    try {
      const svg = await draw(source, theme, variables);
      remember(key, svg);
      // **The element may be gone.** Two keystrokes during that await and
      // `pane.ts` has replaced the pane's HTML; this node is detached, and the
      // one on screen is a different object which the next pass will fill from
      // the cache entry just written.
      if (node.isConnected) node.innerHTML = svg;
    } catch (error) {
      // Not cached: a diagram is mistyped for most of the time it is being
      // written, and caching the failure would mean the first correct version
      // after it still showed the error.
      if (!node.isConnected) continue;
      node.replaceChildren(failure(messageOf(error), source));
    }
  }
}

/**
 * Mermaid throws several shapes -- an `Error`, its own `UnknownDiagramError`,
 * and occasionally a bare string. Only the first line is shown: the parse
 * errors carry a multi-line ASCII pointer that is unreadable out of context.
 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.trim();
}

/** Test-only: the render cache, so a test can prove a second pass does not redraw. */
export const cacheForTests = cache;
