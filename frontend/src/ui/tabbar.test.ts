// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
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

/** Records every hashpad:command dispatched on `document` from this point on. */
function captureCommands(): string[] {
  const seen: string[] = [];
  document.addEventListener(COMMAND_EVENT, (event) => {
    seen.push((event as CustomEvent<string>).detail);
  });
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
