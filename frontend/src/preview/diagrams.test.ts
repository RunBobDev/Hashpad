// @vitest-environment jsdom
/**
 * The half of SPEC §7.2 that draws Mermaid diagrams.
 *
 * **What these tests can and cannot prove, stated up front because the gap is
 * unusually large.** `mermaid.render` calls `getBBox` on an SVG node to measure
 * laid-out text, and jsdom does not implement it -- measured: the call throws
 * before producing anything. So nothing here renders a real diagram. Every case
 * below stubs the module and asserts the machinery *around* it: the placeholder
 * contract, the cache that makes a document with diagrams typeable, the
 * connected check that drops a stale async result, and the failure path.
 *
 * Whether a diagram actually draws, whether a hostile label stays inert, and
 * whether Mermaid cleans up after itself are all `harness/diagrams.html`'s
 * questions, and cannot be answered anywhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGRAM_CLASS } from './rules/mermaid';

/**
 * The module under test, freshly imported per case.
 *
 * Every piece of state this file exercises -- whether Mermaid has loaded, the
 * SVG cache -- lives at module scope, so sharing one instance across cases
 * makes them order-dependent. `math.test.ts` learned that from a shuffle
 * failure; this file starts where that one ended up.
 */
async function freshModule(): Promise<typeof import('./diagrams')> {
  vi.resetModules();
  return import('./diagrams');
}

/** What `mermaid.render` is replaced with, and what it was asked to draw. */
function stubMermaid(render: (id: string, source: string) => Promise<{ svg: string }>): {
  calls: string[];
} {
  const calls: string[] = [];
  vi.doMock('mermaid', () => ({
    default: {
      initialize: vi.fn(),
      render: (id: string, source: string) => {
        calls.push(source);
        return render(id, source);
      },
    },
  }));
  return { calls };
}

function paneWith(...sources: string[]): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = sources
    .map((source) => `<div class="${DIAGRAM_CLASS}">${source}</div>`)
    .join('');
  // Connected, because `renderDiagramsIn` refuses to write to a detached node
  // and every case here wants the write to land.
  document.body.append(root);
  return root;
}

/** Calls the pass until the placeholders have settled. */
async function settle(
  module: typeof import('./diagrams'),
  root: HTMLElement,
  dark = false,
): Promise<void> {
  await module.renderDiagramsIn(root, dark);
  // The first pass only starts the import. A second one draws.
  if (root.querySelector('svg, .preview-mermaid-error') === null) {
    await vi.waitFor(async () => {
      await module.renderDiagramsIn(root, dark);
      expect(root.querySelector('svg, .preview-mermaid-error')).not.toBeNull();
    });
  }
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.doUnmock('mermaid');
  vi.resetModules();
});

describe('drawing diagrams into the sanitised DOM', () => {
  it('leaves a document with no diagrams entirely alone', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    const root = document.createElement('div');
    root.innerHTML = '<p>no diagrams here</p>';
    const before = root.innerHTML;
    await module.renderDiagramsIn(root, false);

    expect(root.innerHTML).toBe(before);
    expect(calls).toEqual([]);
  });

  it('draws a placeholder and keeps the source out of the result', async () => {
    stubMermaid(() => Promise.resolve({ svg: '<svg id="drawn"></svg>' }));
    const module = await freshModule();

    const root = paneWith('graph TD; A--&gt;B');
    await settle(module, root);

    expect(root.querySelector('svg')?.id).toBe('drawn');
  });

  /**
   * The placeholder holds its source as text, which is both the fallback while
   * the chunk loads and the input the pass reads back. `&gt;` has to arrive at
   * Mermaid as `>`.
   */
  it('hands Mermaid the decoded source', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    await settle(module, paneWith('graph TD; A--&gt;B'));

    expect(calls.at(-1)).toBe('graph TD; A-->B');
  });

  /**
   * **The cache is what makes a document with diagrams typeable.** `pane.ts`
   * replaces the whole pane's HTML every 150 ms while you type; without this,
   * every keystroke anywhere in the document re-runs Mermaid on every diagram
   * in it.
   */
  it('does not redraw an unchanged diagram', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    await settle(module, paneWith('graph TD; A-->B'));
    const afterFirst = calls.length;

    // A second pane, the way a re-render builds one: same source, new elements.
    await settle(module, paneWith('graph TD; A-->B'));

    expect(calls.length).toBe(afterFirst);
    expect(afterFirst).toBe(1);
  });

  it('redraws when the source changes', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    await settle(module, paneWith('graph TD; A-->B'));
    await settle(module, paneWith('graph TD; A-->C'));

    expect(calls).toEqual(['graph TD; A-->B', 'graph TD; A-->C']);
  });

  /**
   * Mermaid bakes its colours into the SVG, so the same diagram in the other
   * theme is a different rendering rather than a stale one. Both stay cached,
   * which is what makes flipping back free.
   */
  it('keys the cache on the theme as well as the source', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    await settle(module, paneWith('graph TD; A-->B'), false);
    await settle(module, paneWith('graph TD; A-->B'), true);
    expect(calls.length).toBe(2);

    // Back to light: served from the cache, not redrawn.
    await settle(module, paneWith('graph TD; A-->B'), false);
    expect(calls.length).toBe(2);
  });

  /**
   * **A render that started two keystrokes ago finishes against a pane that has
   * since been rebuilt.** The element it holds is detached by then, and the one
   * on screen is a different object -- which the next pass fills from the cache
   * entry this render just wrote.
   */
  it('does not write into a detached element', async () => {
    let release: (value: { svg: string }) => void = () => {};
    stubMermaid(
      () =>
        new Promise<{ svg: string }>((resolve) => {
          release = resolve;
        }),
    );
    const module = await freshModule();

    // Load the module first, so the pass below gets as far as calling render.
    const warm = paneWith('warm');
    await module.renderDiagramsIn(warm, false);
    await vi.waitFor(() => {
      expect(module.cacheForTests).toBeDefined();
    });
    release({ svg: '<svg/>' });

    const root = paneWith('graph TD; A-->B');
    const pending = module.renderDiagramsIn(root, false);
    // The pane re-renders: this element is gone.
    root.remove();
    release({ svg: '<svg id="late"></svg>' });
    await pending;

    expect(root.querySelector('svg')).toBeNull();
  });

  /**
   * `pane.ts` answers a thrown renderer by replacing the whole pane with an
   * error card, so a diagram that will not parse must not throw out of here.
   * One mistyped arrow must not blank the document around it -- and a diagram
   * is mistyped for most of the time it is being written.
   */
  it('renders a failure in place rather than throwing', async () => {
    stubMermaid(() => Promise.reject(new Error('Parse error on line 2:\nsome ascii art')));
    const module = await freshModule();

    const root = paneWith('not a diagram');
    await settle(module, root);

    const card = root.querySelector('.preview-mermaid-error');
    expect(card).not.toBeNull();
    // First line only: the parse errors carry a multi-line pointer that is
    // unreadable out of context.
    expect(card?.querySelector('.preview-mermaid-error__message')?.textContent).toBe(
      'Parse error on line 2:',
    );
    // The source is shown, so the mistake is visible without going back.
    expect(card?.querySelector('pre')?.textContent).toBe('not a diagram');
  });

  /**
   * A failure is deliberately not cached: the next keystroke is usually the one
   * that fixes it, and a cached failure would still be on screen.
   */
  it('does not cache a failure', async () => {
    let fail = true;
    const { calls } = stubMermaid(() =>
      fail ? Promise.reject(new Error('bad')) : Promise.resolve({ svg: '<svg id="fixed"/>' }),
    );
    const module = await freshModule();

    await settle(module, paneWith('half typed'));
    expect(calls.length).toBe(1);

    fail = false;
    const root = paneWith('half typed');
    await settle(module, root);

    expect(calls.length).toBe(2);
    expect(root.querySelector('svg')).not.toBeNull();
  });

  /**
   * **The laziness claim, made mechanical.** SPEC §7.2 requires the dynamic
   * import to be "triggered only when a document actually contains a diagram",
   * and Mermaid is 5.4 MB of the binary -- by a wide margin the most expensive
   * thing here to load by accident.
   *
   * Asserting on the module *factory* rather than on `render`: a document with
   * no diagrams obviously never renders one, so counting render calls would
   * pass whether or not the chunk had been fetched. What must not happen is the
   * import itself.
   */
  it('never imports mermaid for a document with no diagrams', async () => {
    let imports = 0;
    vi.doMock('mermaid', () => {
      imports++;
      return { default: { initialize: vi.fn(), render: () => Promise.resolve({ svg: '<svg/>' }) } };
    });
    const module = await freshModule();

    const root = document.createElement('div');
    root.innerHTML = '<p>prose</p><pre><code>not a diagram</code></pre>';
    document.body.append(root);

    await module.renderDiagramsIn(root, false);
    await module.renderDiagramsIn(root, true);
    // A microtask turn, so an import started but not awaited would still land.
    await Promise.resolve();

    expect(imports).toBe(0);
  });

  /** And the other half: one diagram is enough to pay for it, exactly once. */
  it('imports mermaid once, however many diagrams there are', async () => {
    let imports = 0;
    vi.doMock('mermaid', () => {
      imports++;
      return { default: { initialize: vi.fn(), render: () => Promise.resolve({ svg: '<svg/>' }) } };
    });
    const module = await freshModule();

    await settle(module, paneWith('a', 'b', 'c'));
    await settle(module, paneWith('d'));

    expect(imports).toBe(1);
  });

  /** A second pass over the same DOM must not hand Mermaid its own output. */
  it('is a no-op on a second pass over the same DOM', async () => {
    const { calls } = stubMermaid(() => Promise.resolve({ svg: '<svg/>' }));
    const module = await freshModule();

    const root = paneWith('graph TD; A-->B');
    await settle(module, root);
    const once = root.innerHTML;

    await module.renderDiagramsIn(root, false);

    expect(root.innerHTML).toBe(once);
    expect(calls.length).toBe(1);
  });
});
