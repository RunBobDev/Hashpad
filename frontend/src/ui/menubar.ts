/**
 * The menu bar is HTML rather than a native OS menu because SPEC §6.1 places it
 * on the same 28px row as the window controls, which a native menu cannot do.
 *
 * Items do not call into features directly — they dispatch a `hashpad:command`
 * event. Later checkpoints subscribe to that, so adding a File > Save does not
 * mean editing this file's imports.
 */
import {
  Quit,
  WindowMinimise,
  WindowToggleMaximise,
} from '../../wailsjs/runtime/runtime';

export const COMMAND_EVENT = 'hashpad:command';

interface MenuItem {
  id: string;
  label: string;
  /** Displayed beside the label; every shortcut is discoverable here (SPEC §6.14). */
  shortcut?: string;
  /** Commands whose checkpoint has not landed yet render greyed rather than lying. */
  enabled: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * Checkpoint A can genuinely do very little, so most items are disabled. They
 * are listed anyway to fix the structure and the shortcut assignments; each
 * later checkpoint flips its own items to enabled.
 */
const MENUS: Menu[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New', shortcut: 'Ctrl+N', enabled: false },
      { id: 'file.open', label: 'Open…', shortcut: 'Ctrl+O', enabled: false },
      { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', enabled: false },
      { id: 'file.saveAs', label: 'Save As…', shortcut: 'Ctrl+Shift+S', enabled: false },
      { id: 'file.exit', label: 'Exit', enabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', enabled: true },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', enabled: true },
      { id: 'edit.find', label: 'Find…', shortcut: 'Ctrl+F', enabled: false },
      { id: 'edit.replace', label: 'Replace…', shortcut: 'Ctrl+H', enabled: false },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'view.preview', label: 'Preview', shortcut: 'Ctrl+Shift+P', enabled: false },
      { id: 'view.outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', enabled: false },
      { id: 'view.wordWrap', label: 'Word Wrap', enabled: false },
      { id: 'view.fullscreen', label: 'Full Screen', shortcut: 'F11', enabled: false },
    ],
  },
  {
    label: 'Help',
    items: [{ id: 'help.about', label: 'About Hashpad', enabled: true }],
  },
];

function emit(id: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }));
}

function buildPopup(menu: Menu, anchor: HTMLButtonElement, close: () => void): HTMLElement {
  const popup = document.createElement('div');
  popup.className = 'menu-popup';
  popup.setAttribute('role', 'menu');

  for (const item of menu.items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.disabled = !item.enabled;

    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);

    if (item.shortcut !== undefined) {
      const shortcut = document.createElement('kbd');
      shortcut.textContent = item.shortcut;
      button.append(shortcut);
    }

    button.addEventListener('click', () => {
      close();
      emit(item.id);
    });
    popup.append(button);
  }

  const { left, bottom } = anchor.getBoundingClientRect();
  popup.style.left = `${left}px`;
  popup.style.top = `${bottom}px`;
  return popup;
}

export function mountMenuBar(parent: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'menubar';

  const menus = document.createElement('div');
  menus.className = 'menubar__menus';
  menus.setAttribute('role', 'menubar');

  let openPopup: HTMLElement | null = null;
  let openButton: HTMLButtonElement | null = null;

  const close = (): void => {
    openPopup?.remove();
    openButton?.setAttribute('aria-expanded', 'false');
    openPopup = null;
    openButton = null;
  };

  for (const menu of MENUS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = menu.label;
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = openButton === button;
      close();
      if (wasOpen) return;
      openButton = button;
      button.setAttribute('aria-expanded', 'true');
      openPopup = buildPopup(menu, button, close);
      document.body.append(openPopup);
    });

    menus.append(button);
  }

  document.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  const spacer = document.createElement('div');
  spacer.className = 'menubar__spacer';

  const controls = document.createElement('div');
  controls.className = 'window-controls';

  // Icon-only buttons carry ARIA labels (SPEC §10). Glyphs are inline text
  // rather than an icon font — SPEC §6.1 forbids an icon-font dependency.
  const buttons: { action: string; glyph: string; label: string; onClick: () => void }[] = [
    { action: 'minimise', glyph: '─', label: 'Minimise', onClick: WindowMinimise },
    { action: 'maximise', glyph: '□', label: 'Maximise', onClick: WindowToggleMaximise },
    { action: 'close', glyph: '✕', label: 'Close', onClick: Quit },
  ];

  for (const spec of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = spec.action;
    button.textContent = spec.glyph;
    button.setAttribute('aria-label', spec.label);
    button.addEventListener('click', spec.onClick);
    controls.append(button);
  }

  bar.append(menus, spacer, controls);
  parent.append(bar);
}
