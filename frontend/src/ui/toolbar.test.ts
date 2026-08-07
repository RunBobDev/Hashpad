// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { store } from '../state/appcontext';
import { COMMAND_EVENT } from './menubar';
import {
  buildToolbar,
  DEFAULT_PINNED,
  mountToolbar,
  TOOLBAR_COMMANDS,
  validatePinned,
} from './toolbar';
import { ICONS } from './icons';
import { COMMANDS } from '../editor/commands';
import { closePopupMenu } from './popupmenu';

/** Listeners registered by captureCommands, torn down after each test. */
const captured: ((event: Event) => void)[] = [];

afterEach(() => {
  for (const listener of captured) document.removeEventListener(COMMAND_EVENT, listener);
  captured.length = 0;
  // Several tests below open a popup (heading, overflow, pin/unpin), which
  // popupmenu.ts appends straight to document.body and tracks as a module
  // singleton -- both must be cleared or a popup (and its outside-click /
  // Escape listeners) from one test leaks into the next.
  closePopupMenu();
  document.body.innerHTML = '';
});

/** Records every hashpad:command dispatched on `document` from this point on. */
function captureCommands(): string[] {
  const seen: string[] = [];
  const listener = (event: Event): void => {
    seen.push((event as CustomEvent<string>).detail);
  };
  document.addEventListener(COMMAND_EVENT, listener);
  captured.push(listener);
  return seen;
}

describe('TOOLBAR_COMMANDS', () => {
  it('has exactly the sixteen commands SPEC §6.5 lists', () => {
    expect(TOOLBAR_COMMANDS).toHaveLength(16);
  });

  it('has an icon for every command', () => {
    for (const command of TOOLBAR_COMMANDS) {
      expect(ICONS[command.id], `missing icon for ${command.id}`).toBeTruthy();
    }
  });

  it('shows a shortcut for every command', () => {
    for (const command of TOOLBAR_COMMANDS) {
      expect(command.shortcut, `missing shortcut for ${command.id}`).toBeTruthy();
    }
  });

  it('defaults to the pinned set SPEC §6.13 names', () => {
    expect([...DEFAULT_PINNED]).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'inlineCode',
      'heading',
      'bulletList',
      'numberedList',
      'taskList',
      'link',
      'table',
    ]);
  });

  it('every default pin is a real command', () => {
    const ids = new Set<string>(TOOLBAR_COMMANDS.map((c) => c.id));
    for (const id of DEFAULT_PINNED) expect(ids.has(id)).toBe(true);
  });

  // A toolbar button dispatches `format.<id>`, and main.ts's router guards
  // with `id in COMMANDS` -- necessary, because `heading` deliberately has no
  // entry, but it turns any *other* mismatch into a button that silently does
  // nothing: no throw, no warning, no failing test. `ToolbarCommand.id` is
  // typed against `CommandId` so a typo is a compile error, and this asserts
  // the same thing at runtime for the one id the type deliberately exempts.
  it('names a real command for every id that dispatches one', () => {
    for (const command of TOOLBAR_COMMANDS) {
      if (command.id === 'heading') continue;
      expect(command.id in COMMANDS, `no COMMANDS entry for ${command.id}`).toBe(true);
    }
  });

  // The exemption itself, so "heading has no COMMANDS entry" stays a
  // deliberate fact rather than something the loop above quietly tolerates.
  // Task 7 giving `heading` a real COMMANDS entry would turn that loop's
  // `continue` into a silent skip; this is what would catch it.
  it('heading has no command of its own, and all six levels do', () => {
    expect('heading' in COMMANDS).toBe(false);
    for (const level of [1, 2, 3, 4, 5, 6]) expect(`heading${level}` in COMMANDS).toBe(true);
  });
});

describe('validatePinned', () => {
  it('drops unknown ids from a hand-edited settings file', () => {
    expect(validatePinned(['bold', 'nonsense', 'italic'])).toEqual(['bold', 'italic']);
  });

  it('deduplicates', () => {
    expect(validatePinned(['bold', 'bold'])).toEqual(['bold']);
  });

  it('falls back to the defaults when the value is not an array of strings', () => {
    expect(validatePinned(null)).toEqual([...DEFAULT_PINNED]);
    expect(validatePinned('bold')).toEqual([...DEFAULT_PINNED]);
    expect(validatePinned([1, 2])).toEqual([...DEFAULT_PINNED]);
  });

  // Unpinning everything is a legitimate choice -- everything stays reachable
  // through the overflow menu -- so an empty array is honoured, not overridden.
  it('honours an empty array', () => {
    expect(validatePinned([])).toEqual([]);
  });

  // A wrong implementation that dedupes by keeping the *last* occurrence
  // rather than the first would still pass every test above (all of them use
  // ids that dedupe to a single trivial survivor) -- this is the one case
  // where first-vs-last actually produces different output, since 'bold'
  // stays put and 'italic' would move.
  it('keeps the first occurrence of a repeated id, not the last', () => {
    expect(validatePinned(['bold', 'italic', 'bold'])).toEqual(['bold', 'italic']);
  });

  // A wrong implementation could plausibly filter unknown ids by checking
  // against DEFAULT_PINNED (the ten ids a fresh install starts with) instead
  // of the full sixteen-command TOOLBAR_COMMANDS set -- both pass every test
  // above, since none of them pin a real command that is outside
  // DEFAULT_PINNED. 'footnote' is real (TOOLBAR_COMMANDS) but not one of the
  // ten defaults, so only the correct source list keeps it.
  it('accepts a real command that is not in DEFAULT_PINNED', () => {
    expect(validatePinned(['footnote'])).toEqual(['footnote']);
  });
});

describe('buildToolbar', () => {
  it('renders one button per pinned command, plus the overflow button', () => {
    const bar = buildToolbar(['bold', 'italic'], '');
    const buttons = bar.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(bar.querySelector('[data-command="bold"]')).not.toBeNull();
    expect(bar.querySelector('[data-command="strikethrough"]')).toBeNull();
    expect(bar.querySelector('[data-overflow]')).not.toBeNull();
  });

  // The overflow menu is how every unpinned command stays reachable (SPEC
  // §6.5), so it must survive even an empty pinned list.
  it('renders the overflow button when nothing is pinned', () => {
    expect(buildToolbar([], '').querySelector('[data-overflow]')).not.toBeNull();
  });

  // Task 6 shipped `role="group"` because eleven individual Tab stops did not
  // back up the WAI-ARIA toolbar pattern's promise of one Tab stop with arrow
  // keys moving between buttons. Task 7 adds that roving tabindex (see the
  // 'roving tabindex' describe block below) and restores `role="toolbar"`
  // here now that the promise is true. Still asserts the accessible name,
  // which a bare div's implicit `generic` role would silently drop.
  it('claims the ARIA toolbar keyboard pattern now that roving tabindex backs it up', () => {
    const bar = buildToolbar(['bold'], '');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Formatting');
  });

  it('labels every icon-only button for assistive tech', () => {
    const bar = buildToolbar(['bold'], '');
    for (const button of bar.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  // Colour alone would not carry the state to a screen reader, and
  // aria-pressed is what makes a toggle button announce as one.
  it('marks an active command with aria-pressed', () => {
    const bar = buildToolbar(['bold', 'italic'], 'bold');
    expect(bar.querySelector('[data-command="bold"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(bar.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('reads a multi-format active string', () => {
    const bar = buildToolbar(['bold', 'italic'], 'bold|italic');
    expect(bar.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  // Heading is one button covering six commands, so its active state comes
  // from any heading level being active, not from an id called 'heading'.
  it('marks the heading button active at any level', () => {
    const bar = buildToolbar(['heading'], 'heading3');
    expect(bar.querySelector('[data-command="heading"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('ignores an unknown pinned id rather than throwing', () => {
    const bar = buildToolbar(['bold', 'notacommand'], '');
    expect(bar.querySelectorAll('[data-command]')).toHaveLength(1);
  });

  it('separates the groups SPEC §6.1 shows', () => {
    const bar = buildToolbar(
      TOOLBAR_COMMANDS.map((c) => c.id),
      '',
    );
    expect(bar.querySelectorAll('.toolbar__separator').length).toBeGreaterThan(0);
  });

  // A leading separator (nothing rendered before it) is the failure mode a
  // "separator before every group's first button" implementation produces --
  // as opposed to only *between* two rendered groups, which is what SPEC
  // §6.1's row actually shows.
  it('renders no leading separator when the first pinned command is not in group 1', () => {
    const bar = buildToolbar(['link'], '');
    expect(bar.querySelectorAll('.toolbar__separator')).toHaveLength(0);
  });

  // Pinning is a visibility choice, not a reordering one (ambiguity #1 in the
  // task brief) -- this is the one test in the file that would fail if
  // `buildToolbar` rendered in `pinned`'s order instead of
  // `TOOLBAR_COMMANDS`'s.
  it('renders pinned commands in TOOLBAR_COMMANDS order regardless of the order pinned lists them', () => {
    const bar = buildToolbar(['table', 'bold', 'bulletList'], '');
    const ids = [...bar.querySelectorAll('[data-command]')].map((el) =>
      el.getAttribute('data-command'),
    );
    expect(ids).toEqual(['bold', 'bulletList', 'table']);
  });

  // Present-but-false would satisfy "marks an active command with
  // aria-pressed" above (which only checks bold/italic, both toggle
  // commands) while still violating ambiguity #2: a command with no active
  // state must not carry the attribute at all.
  it('omits aria-pressed entirely for commands with no active state', () => {
    const bar = buildToolbar(['link', 'image', 'table', 'horizontalRule', 'footnote'], '');
    for (const id of ['link', 'image', 'table', 'horizontalRule', 'footnote']) {
      expect(bar.querySelector(`[data-command="${id}"]`)?.hasAttribute('aria-pressed')).toBe(false);
    }
  });

  it('dispatches format.<id> when a formatting button is clicked', () => {
    const bar = buildToolbar(['bold'], '');
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="bold"]')!.click();

    expect(seen).toEqual(['format.bold']);
  });

  // 'heading' names no COMMANDS entry (see TOOLBAR_COMMANDS's comment), so
  // unlike every other button this one must never itself dispatch
  // format.heading -- it opens the level-picker popup instead, and only
  // choosing a level from it (see 'the heading popup' below) may dispatch.
  it('opens a popup rather than dispatching a command when the heading button is clicked', () => {
    const bar = buildToolbar(['heading'], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();

    expect(seen).toEqual([]);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  // Same shape as heading above: opening the overflow list is not itself a
  // command, only choosing something from it is.
  it('opens a popup rather than dispatching a command when the overflow button is clicked', () => {
    const bar = buildToolbar([], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-overflow]')!.click();

    expect(seen).toEqual([]);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe('the heading popup', () => {
  // The overflow menu is what discharges SPEC §6.14 for the sixteen
  // formatting shortcuts -- the owner chose it over adding sixteen entries to
  // the Edit menu, and §6.14 asks for the shortcut to be *displayed* beside
  // the label. `PopupItem.shortcut` is optional, so dropping the mapping
  // would be a silent regression with a green suite.
  it('displays a shortcut beside every command in the overflow menu', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    bar.querySelector<HTMLButtonElement>('[data-overflow]')!.click();

    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(items).toHaveLength(16);
    for (const item of items) {
      expect(
        item.querySelector('kbd')?.textContent,
        `no shortcut shown for ${item.textContent}`,
      ).toBeTruthy();
    }
  });

  it('lists the six heading levels plus Normal text, with Ctrl+1..6 shown', () => {
    const bar = buildToolbar(['heading'], '');
    document.body.append(bar);

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();

    const items = document.querySelectorAll('[role="menu"] [role="menuitem"]');
    expect(items).toHaveLength(7);
    const shortcuts = [...document.querySelectorAll('[role="menu"] kbd')].map(
      (kbd) => kbd.textContent,
    );
    expect(shortcuts).toEqual(['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6']);
    expect(items[6]?.textContent).toContain('Normal text');
  });

  it('emits format.heading<n> for the level chosen', () => {
    const bar = buildToolbar(['heading'], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();
    document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')[2]!.click();

    expect(seen).toEqual(['format.heading3']);
  });

  // "Normal text" has to name the level that is currently on, because
  // toggleHeading(level) (editor/commands.ts) only removes a heading when the
  // line already carries that exact level -- a wrong implementation that
  // always emits a fixed level (e.g. format.heading1) would pass a test that
  // only checked *a* command was dispatched, so this pins the specific one.
  it('emits format.heading<n> for the currently active level when Normal text is chosen', () => {
    const bar = buildToolbar(['heading'], 'heading4');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
    items[items.length - 1]!.click();

    expect(seen).toEqual(['format.heading4']);
  });

  // No heading is active, so there is nothing for "Normal text" to turn off
  // -- a wrong implementation that unconditionally emits some format.heading*
  // command regardless of the active string would fail this.
  it('dispatches nothing for Normal text when no heading is currently active', () => {
    const bar = buildToolbar(['heading'], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
    items[items.length - 1]!.click();

    expect(seen).toEqual([]);
  });
});

describe('mountToolbar', () => {
  it("renders the default pinned set using the store's current activeFormats", () => {
    store.setState((prev) => ({ ...prev, activeFormats: 'bold' }));
    const parent = document.createElement('div');

    mountToolbar(parent, DEFAULT_PINNED);

    expect(parent.querySelector('[data-command="bold"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(parent.querySelector('[data-command="bulletList"]')).not.toBeNull();
  });

  // Task 8: main.ts passes the settings-validated pinned list explicitly
  // rather than mountToolbar reaching for DEFAULT_PINNED itself. A wrong
  // implementation that kept the old hard-coded seed would still pass every
  // other test in this describe block (none of them pass a second argument),
  // so only a test that does is able to tell the two apart.
  it('seeds from the given pinned list instead of DEFAULT_PINNED when one is passed', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');

    mountToolbar(parent, ['footnote']);

    expect(parent.querySelector('[data-command="footnote"]')).not.toBeNull();
    // 'bold' is in DEFAULT_PINNED but not in the list just passed in.
    expect(parent.querySelector('[data-command="bold"]')).toBeNull();
  });

  // Proves the row is rebuilt from a live subscription, not rendered once
  // from whatever activeFormats happened to be at mount time.
  it('rebuilds when activeFormats changes after mounting', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    mountToolbar(parent, DEFAULT_PINNED);
    expect(parent.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );

    store.setState((prev) => ({ ...prev, activeFormats: 'italic' }));

    expect(parent.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('roving tabindex', () => {
  function focusableButtons(bar: HTMLElement): HTMLButtonElement[] {
    return [...bar.querySelectorAll<HTMLButtonElement>('button')];
  }

  it('starts with only the first button in the Tab order', () => {
    const bar = buildToolbar(['bold', 'italic'], '');
    const buttons = focusableButtons(bar);
    // bold, italic, overflow -- only the first is a Tab stop.
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  // A wrong implementation that moves focus without also updating tabIndex
  // (e.g. `button.focus()` alone, roving state left untouched) would still
  // satisfy an assertion that only checked document.activeElement -- this
  // checks both, so a "roving tabindex" that doesn't actually rove fails it
  // even though focus itself did move.
  it('moves both focus and the Tab stop with ArrowRight', () => {
    const bar = buildToolbar(['bold', 'italic'], '');
    document.body.append(bar);
    const [bold, italic] = focusableButtons(bar);
    bold!.focus();

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(document.activeElement).toBe(italic);
    expect(bold!.tabIndex).toBe(-1);
    expect(italic!.tabIndex).toBe(0);
  });

  it('wraps from the first button to the last (the overflow button) with ArrowLeft', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    const buttons = focusableButtons(bar);
    const bold = buttons[0]!;
    const overflow = buttons[buttons.length - 1]!;
    bold.focus();

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

    expect(document.activeElement).toBe(overflow);
  });

  it('jumps to the last button with End and back to the first with Home', () => {
    const bar = buildToolbar(['bold', 'italic'], '');
    document.body.append(bar);
    const buttons = focusableButtons(bar);
    buttons[0]!.focus();

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  // A real click focuses the button it lands on (jsdom does not simulate
  // that automatically, so this proves the point by focusing directly, the
  // same observable state a click would leave behind). A wrong
  // implementation that only updates the Tab stop from inside the ArrowKey
  // handlers -- e.g. the first draft of this function, which mutated
  // tabIndex only in a `moveTo` helper the keydown cases called -- would
  // leave every button's tabIndex exactly as buildToolbar first set it here,
  // since nothing outside a keydown ever touches it. That would fail this.
  it('syncs the Tab stop to whichever button gains focus, not only via the arrow keys', () => {
    const bar = buildToolbar(['bold', 'italic'], '');
    document.body.append(bar);
    const buttons = focusableButtons(bar);

    buttons[1]!.focus();

    expect(buttons[0]!.tabIndex).toBe(-1);
    expect(buttons[1]!.tabIndex).toBe(0);
  });
});

describe('the overflow menu', () => {
  it('lists all sixteen commands regardless of what is pinned', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    bar.querySelector<HTMLButtonElement>('[data-overflow]')?.click();
    expect(document.querySelectorAll('[role="menu"] [role="menuitem"]')).toHaveLength(16);
  });

  // 'heading' is one of the sixteen listed here, but it has no COMMANDS entry
  // (TOOLBAR_COMMANDS's comment) -- same as the pinned heading button, so a
  // wrong implementation that literally read "emits format.<id> for all
  // sixteen" and applied that uniformly would dispatch a dead format.heading
  // here instead of opening the level picker. This fails that.
  it('opens the heading popup, rather than dispatching format.heading, when Heading is chosen', () => {
    const bar = buildToolbar([], '');
    document.body.append(bar);
    const seen = captureCommands();
    const headingIndex = TOOLBAR_COMMANDS.findIndex((c) => c.id === 'heading');

    bar.querySelector<HTMLButtonElement>('[data-overflow]')!.click();
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
    items[headingIndex]!.click();

    expect(seen).toEqual([]);
    expect(document.querySelectorAll('[role="menu"] [role="menuitem"]')).toHaveLength(7);
  });

  it('emits format.<id> for a plain command chosen from the overflow', () => {
    const bar = buildToolbar([], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-overflow]')!.click();
    document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')!.click();

    expect(seen).toEqual(['format.bold']);
  });
});

describe('the pin/unpin context menu', () => {
  it('opens on right-click with every command listed and the pinned ones ticked', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const items = document.querySelectorAll('[role="menuitemcheckbox"]');
    expect(items).toHaveLength(16);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
  });

  // Ambiguity #3 in the task brief: without this, WebView2 shows its own
  // context menu on top of ours.
  it('prevents the default context menu', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    bar.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('emits toolbar.unpin:<id> when a currently pinned command is chosen', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    const seen = captureCommands();

    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!.click(); // bold

    expect(seen).toEqual(['toolbar.unpin:bold']);
  });

  it('emits toolbar.pin:<id> when a command that is not pinned is chosen', () => {
    const bar = buildToolbar(['bold'], '');
    document.body.append(bar);
    const seen = captureCommands();
    const italicIndex = TOOLBAR_COMMANDS.findIndex((c) => c.id === 'italic');

    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')[italicIndex]!.click();

    expect(seen).toEqual(['toolbar.pin:italic']);
  });
});

describe('mountToolbar pin/unpin', () => {
  /** Right-clicks the mounted row and clicks the popup item labelled `label`. */
  function togglePinVia(parent: HTMLElement, label: string): void {
    const bar = parent.querySelector('.toolbar')!;
    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ].find((button) => button.textContent?.includes(label));
    expect(item, `no pin/unpin item labelled ${label}`).toBeDefined();
    item!.click();
  }

  // Drives the real path a user takes -- right-click, choose an item -- rather
  // than dispatching `toolbar.pin:<id>` on the bus. The bus version passed
  // against a `mountToolbar` that listened to its own emitted events, a
  // self-loop that also fired for any other dispatcher of those ids; the row
  // now updates through a direct callback, so only the user path proves it.
  it('adds a button when an unpinned command is chosen in the pin menu', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    document.body.append(parent);
    mountToolbar(parent, DEFAULT_PINNED);
    expect(parent.querySelector('[data-command="highlight"]')).toBeNull();

    togglePinVia(parent, 'Highlight');

    expect(parent.querySelector('[data-command="highlight"]')).not.toBeNull();
  });

  it('removes a button when a pinned command is chosen in the pin menu', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    document.body.append(parent);
    mountToolbar(parent, DEFAULT_PINNED);
    expect(parent.querySelector('[data-command="bold"]')).not.toBeNull();

    togglePinVia(parent, 'Bold');

    expect(parent.querySelector('[data-command="bold"]')).toBeNull();
  });

  // Task 8 persists these, so the announcement has to survive the move off
  // the bus for the in-session toggle.
  it('still announces the change on the shared bus for settings to persist', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    document.body.append(parent);
    mountToolbar(parent, DEFAULT_PINNED);
    const seen = captureCommands();

    togglePinVia(parent, 'Highlight');

    expect(seen).toContain('toolbar.pin:highlight');
  });

  // The Critical this task shipped and had to fix: the row is replaced whole
  // on every activeFormats change -- which includes every use of a toolbar
  // button -- so a Tab stop seated unconditionally on button 0 reset itself
  // the moment the user activated anything else, and the focused node was
  // detached with focus falling back to <body>.
  it('keeps the Tab stop and focus on the same button across a rebuild', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    document.body.append(parent);
    mountToolbar(parent, DEFAULT_PINNED);

    const buttons = () => [...parent.querySelectorAll<HTMLButtonElement>('.toolbar button')];
    const third = buttons()[2]!;
    const thirdCommand = third.dataset.command;
    third.focus();

    store.setState((prev) => ({ ...prev, activeFormats: 'bold' }));

    const rebuilt = buttons()[2]!;
    expect(rebuilt.dataset.command).toBe(thirdCommand);
    expect(rebuilt.tabIndex).toBe(0);
    expect(document.activeElement).toBe(rebuilt);
    expect(buttons().filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it('leaves focus alone when the rebuild happens while the row is unfocused', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    document.body.append(parent);
    mountToolbar(parent, DEFAULT_PINNED);

    store.setState((prev) => ({ ...prev, activeFormats: 'bold' }));

    expect(parent.contains(document.activeElement)).toBe(false);
  });
});
