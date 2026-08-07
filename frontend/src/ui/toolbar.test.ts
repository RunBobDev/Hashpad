// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { store } from '../state/appcontext';
import { COMMAND_EVENT } from './menubar';
import { buildToolbar, DEFAULT_PINNED, mountToolbar, TOOLBAR_COMMANDS } from './toolbar';
import { ICONS } from './icons';
import { COMMANDS } from '../editor/commands';

/** Listeners registered by captureCommands, torn down after each test. */
const captured: ((event: Event) => void)[] = [];

afterEach(() => {
  for (const listener of captured) document.removeEventListener(COMMAND_EVENT, listener);
  captured.length = 0;
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

  // `role="toolbar"` would promise the WAI-ARIA toolbar pattern -- one Tab
  // stop, arrow keys between the buttons -- which these eleven individual Tab
  // stops do not implement. `role="group"` claims no keyboard contract while
  // still supporting the accessible name; a bare div's implicit `generic`
  // role does not, so dropping the role entirely would silently lose the
  // label. Pinned so Task 7 cannot restore `toolbar` without also adding the
  // roving tabindex that would make it true.
  it('groups the buttons without claiming the ARIA toolbar keyboard pattern', () => {
    const bar = buildToolbar(['bold'], '');
    expect(bar.getAttribute('role')).toBe('group');
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

  // Task 7 owns the heading level dropdown; until it lands, clicking must
  // not dispatch a command that names a non-existent 'heading' entry in
  // COMMANDS.
  it('does not dispatch a command when the heading button is clicked', () => {
    const bar = buildToolbar(['heading'], '');
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-command="heading"]')!.click();

    expect(seen).toEqual([]);
  });

  // Task 7 owns the overflow popup; until it lands, clicking must be inert.
  it('does not dispatch a command when the overflow button is clicked', () => {
    const bar = buildToolbar([], '');
    const seen = captureCommands();

    bar.querySelector<HTMLButtonElement>('[data-overflow]')!.click();

    expect(seen).toEqual([]);
  });
});

describe('mountToolbar', () => {
  it("renders the default pinned set using the store's current activeFormats", () => {
    store.setState((prev) => ({ ...prev, activeFormats: 'bold' }));
    const parent = document.createElement('div');

    mountToolbar(parent);

    expect(parent.querySelector('[data-command="bold"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(parent.querySelector('[data-command="bulletList"]')).not.toBeNull();
  });

  // Proves the row is rebuilt from a live subscription, not rendered once
  // from whatever activeFormats happened to be at mount time.
  it('rebuilds when activeFormats changes after mounting', () => {
    store.setState((prev) => ({ ...prev, activeFormats: '' }));
    const parent = document.createElement('div');
    mountToolbar(parent);
    expect(parent.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );

    store.setState((prev) => ({ ...prev, activeFormats: 'italic' }));

    expect(parent.querySelector('[data-command="italic"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
