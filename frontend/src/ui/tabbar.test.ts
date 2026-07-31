// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createUntitledDocument, type Document } from '../state/document';
import { COMMAND_EVENT } from './menubar';
import { buildTabStrip, tabActivateCommand, tabCloseCommand } from './tabbar';

/** A document with a stable id; clean by construction (editorState.doc === savedDoc). */
function docWith(overrides: Partial<Document> = {}): Document {
  return { ...createUntitledDocument(EditorState.create({ doc: 'hello' })), ...overrides };
}

/** A document whose editorState has diverged from savedDoc -- isDirty(doc) is true. */
function dirtyDoc(overrides: Partial<Document> = {}): Document {
  const original = EditorState.create({ doc: 'hello' });
  const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
  return docWith({ editorState: changed, savedDoc: original.doc, ...overrides });
}

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

function tabsOf(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
}

describe('buildTabStrip', () => {
  it('renders one tab per document, in order', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const tabs = tabsOf(buildTabStrip(docs, 'a'));
    expect(tabs).toHaveLength(3);
  });

  it('marks the active tab selected and no other', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const [a, b, c] = tabsOf(buildTabStrip(docs, 'b'));
    expect(a!.getAttribute('aria-selected')).toBe('false');
    expect(b!.getAttribute('aria-selected')).toBe('true');
    expect(c!.getAttribute('aria-selected')).toBe('false');
  });

  it('shows no dirty dot on a clean document', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')).toBeNull();
  });

  it('shows a dirty dot on a dirty document', () => {
    const doc = dirtyDoc({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')).not.toBeNull();
  });

  it('hides the dirty dot from screen readers -- it is decoration', () => {
    const doc = dirtyDoc({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('titles a saved document with its full path', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.getAttribute('title')).toBe('C:\\notes\\todo.md');
  });

  it('gives an untitled document no title attribute at all', () => {
    const doc = docWith({ id: 'a', filePath: null });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.hasAttribute('title')).toBe(false);
  });

  it('labels the tab with the basename, not the full path', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__label')!.textContent).toBe('todo.md');
  });

  it('names the close button after the document', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const close = tab!.querySelector('.tab__close')!;
    expect(close.getAttribute('aria-label')).toBe('Close todo.md');
  });

  it('dispatches an activate command with the right id when a tab is clicked', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const tabs = tabsOf(buildTabStrip(docs, 'a'));
    const seen = captureCommands();

    tabs[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    expect(seen).toEqual([tabActivateCommand('b')]);
  });

  it('dispatches a close command on middle-click', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 }));

    expect(seen).toEqual([tabCloseCommand('a')]);
  });

  it('does not close on left-click', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(seen).toEqual([]);
  });

  it('dispatches close, not activate, when the close button is clicked', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.querySelector<HTMLButtonElement>('.tab__close')!.click();

    expect(seen).toEqual([tabCloseCommand('a')]);
  });
});

describe('accessible naming', () => {
  it('names a clean tab with just the filename', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a', filePath: '/notes/todo.md' })], 'a'));
    expect(tab!.getAttribute('aria-label')).toBe('todo.md');
  });

  // The dirty dot is aria-hidden decoration, so without this the only cue that
  // a document has unsaved changes would never reach a screen reader.
  it('names a dirty tab as having unsaved changes', () => {
    const [tab] = tabsOf(buildTabStrip([dirtyDoc({ id: 'a', filePath: '/notes/todo.md' })], 'a'));
    expect(tab!.getAttribute('aria-label')).toBe('todo.md, unsaved changes');
  });

  // A <button> may not contain interactive content; browsers enforce that by
  // flattening the subtree in the accessibility tree, which would strip the
  // close button's role and bleed its label into the tab's own name.
  it('does not nest the close button inside a button element', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));
    expect(tab!.tagName).not.toBe('BUTTON');
    expect(tab!.closest('button')).toBeNull();
  });

  it('keeps each tab reachable by keyboard', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));
    expect(tab!.tabIndex).toBe(0);
  });
});

describe('keyboard activation', () => {
  it('activates the tab on Enter', () => {
    const seen = captureCommands();
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' }), docWith({ id: 'b' })], 'b'));

    tab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(seen).toEqual([tabActivateCommand('a')]);
  });

  it('ignores other keys', () => {
    const seen = captureCommands();
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));

    tab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(seen).toEqual([]);
  });

  // Enter on the close button must close only. Without the target check the
  // keydown bubbles to the tab and activates the tab it just closed.
  it('does not also activate when Enter lands on the close button', () => {
    const seen = captureCommands();
    const strip = buildTabStrip([docWith({ id: 'a' })], 'a');
    const close = strip.querySelector<HTMLButtonElement>('.tab__close');

    close!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(seen).not.toContain(tabActivateCommand('a'));
  });
});

describe('the new-tab button', () => {
  it('dispatches the new-document command', () => {
    const seen = captureCommands();
    const strip = buildTabStrip([docWith({ id: 'a' })], 'a');

    strip.querySelector<HTMLButtonElement>('.tabbar__new')!.click();

    expect(seen).toEqual(['file.new']);
  });
});
