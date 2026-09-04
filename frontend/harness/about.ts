/**
 * What the About dialog actually looks like, in both themes.
 *
 * `aboutdialog.test.ts` asserts its contents and its teardown, and can say
 * nothing about the thing a dialog is mostly made of: jsdom implements
 * `<dialog>` as a bare `HTMLElement`, so `showModal()` does not exist there,
 * the backdrop is never painted, and every dimension is zero. Whether the box
 * is the right size, whether the repository URL fits inside it, and whether it
 * reads correctly on a dark background are questions only a browser answers.
 *
 * **One dialog and a theme switch, not two panels side by side.** Two panels
 * was the first version and it was a lie: `variables.css` defines the palette
 * on `:root[data-theme='dark']`, so a `data-theme` on a `<section>` selects
 * nothing at all and the "dark" panel rendered in the light palette. It looked
 * like proof that the dialog themes correctly, and proved only that both
 * panels were light. The theme has to move on `document.documentElement`.
 */
import { buildAboutDialog } from '../src/ui/aboutdialog';
import '../src/styles/app.css';

const app = document.querySelector('#app')!;
app.setAttribute('style', 'padding:16px;background:var(--bg-app);min-height:100vh');

// `open` rather than `showModal`, and appended in place: a modal is in the top
// layer, which would take it out of the flow this page controls. The frame,
// padding and content are identical either way; only the backdrop is missing,
// and that is one flat token.
const dialog = buildAboutDialog();
dialog.style.cssText = 'position:static;display:block;margin:0';
app.append(dialog);

declare global {
  interface Window {
    about: () => Record<string, string>;
    setTheme: (theme: 'light' | 'dark') => string;
  }
}

/** The root, which is the only element the palette actually keys off. */
window.setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  return getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim();
};

/** The measurements worth checking: the box's size, and whether the URL fits. */
window.about = () => {
  const dialog = document.querySelector('.about-dialog')!;
  const url = [...dialog.querySelectorAll('dd')].find((dd) =>
    (dd.textContent ?? '').startsWith('https://'),
  );
  const box = dialog.getBoundingClientRect();
  return {
    width: `${String(Math.round(box.width))}px`,
    height: `${String(Math.round(box.height))}px`,
    version: dialog.querySelector('.about-dialog__version')?.textContent ?? 'missing',
    urlOverflows: url === undefined ? 'no url' : String(url.scrollWidth > url.clientWidth),
    buttons: [...dialog.querySelectorAll('button')].map((b) => b.textContent).join(', '),
  };
};
