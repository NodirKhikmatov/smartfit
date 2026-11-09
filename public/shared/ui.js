// Smart Fit UI helpers shared by the customer app and admin. Styles live in ui.css.
import { t } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';

// <svg class="icon"><use href="/shared/icons.svg#name"></svg>. Decorative unless a label is given.
export function icon(name, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `/shared/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// A short status message at the bottom of the screen, read out politely by screen readers.
let region;
export function toast(text, { tone = 'ok', ms = 4000 } = {}) {
  if (!region?.isConnected) {
    region = Object.assign(document.createElement('div'), { className: 'toast-region' });
    region.setAttribute('role', 'status');
    document.body.append(region);
  }
  const node = Object.assign(document.createElement('div'), { className: `toast ${tone}` });
  node.append(icon(tone === 'danger' ? 'alert' : 'check'), text);
  region.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  }, ms);
  return node;
}

// A styled replacement for window.confirm(). Resolves true only when the action button is pressed; Esc and the cancel button resolve false.
export function confirmDialog({ title, text = '', ok, cancel = t('common.cancel'), danger = false }) {
  const dlg = Object.assign(document.createElement('dialog'), { className: 'narrow' });
  const h = Object.assign(document.createElement('h2'), { textContent: title });
  const p = Object.assign(document.createElement('p'), { className: 'muted', textContent: text });
  const no = Object.assign(document.createElement('button'), { type: 'button', textContent: cancel, value: '' });
  const yes = Object.assign(document.createElement('button'), { type: 'button', className: danger ? 'danger solid' : 'primary', textContent: ok, value: 'yes' });
  const actions = Object.assign(document.createElement('div'), { className: 'dialog-actions' });
  actions.append(no, yes);
  dlg.append(h, ...(text ? [p] : []), actions);
  dlg.setAttribute('aria-labelledby', (h.id = `dlg-${Math.random().toString(36).slice(2)}`));
  document.body.append(dlg);
  return new Promise((resolve) => {
    // Buttons settle directly; the async 'close' event only covers Esc.
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(ok);
    };
    no.onclick = () => finish(false);
    yes.onclick = () => finish(true);
    dlg.addEventListener('close', () => finish(false));
    dlg.showModal();
    (danger ? no : yes).focus(); // a destructive action is never the default
  });
}

// Runs show() only if the work takes longer than ms, so fast loads don't flash a skeleton. Call the returned function when done.
export function showAfter(ms, show) {
  const timer = setTimeout(show, ms);
  return () => clearTimeout(timer);
}

// Skeleton placeholder: n lines of grey shimmer inside a card.
export function skeletonCard(lines = 3) {
  const card = Object.assign(document.createElement('div'), { className: 'card skeleton-card' });
  card.setAttribute('aria-hidden', 'true');
  card.append(...Array.from({ length: lines }, (_, i) => Object.assign(document.createElement('span'), { className: `skeleton ${i === 0 ? 'line short' : 'block'}` })));
  return card;
}
