// @vitest-environment jsdom
/**
 * A focused sibling to main.test.ts, in its own file so its LoadSettings
 * mock can resolve a `toolbar.pinned` list that differs from
 * `DEFAULT_PINNED` -- main.test.ts's shared `beforeAll` bootstrap already
 * commits to one mocked settings shape (deliberately equal to
 * DEFAULT_PINNED, so its own tests aren't testing settings-seeding at all),
 * and a bootstrap only runs once per module instance. Vitest gives every
 * test *file* its own fresh module registry by default, which is exactly
 * what a second, differently-mocked bootstrap needs.
 *
 * This is the test that actually proves Task 8's "seed the initial list from
 * settings": the plausible wrong implementation it is built to catch is a
 * `mountToolbar` call that still hard-codes `DEFAULT_PINNED` (i.e. Task 8's
 * seeding change never actually shipped, or got seeded from the store's
 * pre-bootstrap placeholder instead of the loaded settings). That
 * implementation would pass every test in main.test.ts, because that file's
 * mock happens to use the same ten ids as DEFAULT_PINNED -- it would only
 * fail here, where the mocked pinned list is deliberately disjoint from it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from './state/appcontext';
import { ShowWindow } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  // ui/filedrop.ts subscribes at module load. A missing export here is a hard
  // mock error rather than a silent fallback, which is how these five files
  // announced themselves the moment main.ts imported it.
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    // bootstrap validates `window.previewSplitRatio` and seeds the store with it.
    window: {
      previewSplitRatio: 0.5,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    // Also read by bootstrap. Go always sends the block, so a mock without it
    // would make bootstrap throw where the real app never can.
    // Both blocks are read by bootstrap and Go always sends them, so a mock
    // without them makes bootstrap throw where the real app never can -- and a
    // bootstrap that throws silently runs its `catch` path, seeding every
    // setting from the compiled-in defaults instead of from this mock. That is
    // exactly what happened to this file between G.1 and G.2: `editor` was
    // added to the read and not to the mock, and no test noticed.
    preview: { syncScroll: true },
    editor: { wordWrap: true },
    // Neither of these is in DEFAULT_PINNED (bold, italic, strikethrough,
    // inlineCode, heading, bulletList, numberedList, taskList, link, table).
    toolbar: { visible: true, pinned: ['blockquote', 'footnote'] },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('bootstrap seeding the toolbar from settings', () => {
  // Bootstrapped once, in beforeAll, then queried by independent tests --
  // the shape main.test.ts already uses. Within one test file the ESM
  // registry is shared, so a second `await import('./main')` returns the
  // cached module and re-runs no side effects; bootstrapping inside each
  // `it` would leave the second one querying an empty `#app`. Splitting the
  // assertions this way keeps a seeding regression from short-circuiting the
  // test before the position assertion is ever evaluated.
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  /**
   * An editor nobody has clicked in takes no typing at all -- focus sits on
   * `<body>` -- so bootstrap focuses it before the window is shown, the way
   * Notepad opens with a caret in the document. Asserted in this file rather
   * than in `main.test.ts` because nothing here moves focus, and
   * `--sequence.shuffle` makes "which test ran before this one" unanswerable
   * anywhere that does.
   */
  /**
   * The chrome rows of `#app`, in order. `.window-edge` children are filtered
   * out: they are the frameless window's resize border (ui/windowedges.ts), fixed
   * to the viewport rather than laid out in the column, so they are not rows and
   * their position among the children means nothing.
   */
  function chromeRows(): string[] {
    const app = document.querySelector('#app')!;
    return [...app.children]
      .map((child) => child.className)
      .filter((name) => !name.startsWith('window-edge'));
  }

  it('leaves the caret in the editor, ready to type', () => {
    expect(document.activeElement?.classList.contains('cm-content')).toBe(true);
  });

  it('renders the pinned commands settings.json named, not the compiled-in default', () => {
    expect(document.querySelector('[data-command="blockquote"]')).not.toBeNull();
    expect(document.querySelector('[data-command="footnote"]')).not.toBeNull();
    // 'bold' is in DEFAULT_PINNED but not in this settings file's list --
    // its presence here would mean the seed came from the compiled-in
    // default instead of settings.toolbar.pinned.
    expect(document.querySelector('[data-command="bold"]')).toBeNull();
  });

  // The toolbar mounts from bootstrap's async `finally`, which runs long
  // after `editorArea` is in the tree -- so `parent.append` put SPEC §6.1's
  // formatting row *below the editor*, at the bottom of the window. `#app`
  // is a plain flex column with no `order` anywhere, so DOM order is visual
  // order, and nothing caught it: every other toolbar assertion tests
  // presence, and both builds were silent.
  //
  // Extended in G.2 to the whole chrome stack rather than just the toolbar's
  // slot in it: the status bar is the one row that *is* appended, so it is the
  // one row for which "below the editor" is correct -- and an assertion listing
  // every child in order is what keeps the next row someone adds from landing
  // between them by accident.
  it('sits between the tab strip and the editor area', () => {
    expect(chromeRows()).toEqual([
      'menubar',
      'tabbar',
      'toolbar',
      // The outline sidebar lives *inside* this row, not beside it in `#app` --
      // see main.ts for why the two rows are nested.
      'workspace',
      'statusbar',
    ]);
  });

  // The row is replaced on every activeFormats change. `replaceWith`
  // substitutes at the same index so position survives -- but the assertion
  // above only ever observes the *mount* path, because the initial document
  // is empty and republishes '' against a store already holding '', so no
  // rebuild has happened by then. Switching `replaceWith` to `append` would
  // send the row to the bottom on the first keystroke, unnoticed.
  it('stays there after a rebuild', () => {
    store.setState((prev) => ({ ...prev, activeFormats: 'bold' }));

    expect(chromeRows()).toEqual([
      'menubar',
      'tabbar',
      'toolbar',
      // The outline sidebar lives *inside* this row, not beside it in `#app` --
      // see main.ts for why the two rows are nested.
      'workspace',
      'statusbar',
    ]);
  });
});
