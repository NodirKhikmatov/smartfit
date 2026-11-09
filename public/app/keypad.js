// Kiosk on-screen keyboard (audit U4): a kiosk touch screen may have no OS keyboard. An input opts in with
// data-keys="digits|phone|letters"; while it has focus the dock is shown and types into it. Keys never take the focus.
import { t, getLang } from '/shared/i18n.js';
import { icon } from '/shared/ui.js';

const DIGITS = ['123', '456', '789'];

export function keypad() {
  const dock = Object.assign(document.createElement('div'), { className: 'keypad', hidden: true });
  document.body.append(dock);
  let target = null;

  const key = (k, label = k, className = '') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', tabIndex: -1, className: `key ${className}` });
    b.dataset.key = k;
    typeof label === 'string' ? (b.textContent = label) : b.append(label);
    return b;
  };
  const row = (...keys) => {
    const d = Object.assign(document.createElement('div'), { className: 'key-row' });
    d.append(...keys);
    return d;
  };
  function draw(kind) {
    dock.dataset.kind = kind;
    const back = key('back', icon('backspace', t('kiosk.keys.back')), 'fn');
    const done = key('done', t('kiosk.keys.done'), 'primary done');
    if (kind === 'letters') {
      // The letter rows come from the dictionary, so the layout follows the language.
      dock.replaceChildren(...t('kiosk.keys.rows').split(' ').map((r) => row(...[...r].map((c) => key(c)))), row(key(' ', t('kiosk.keys.space'), 'space'), back, done));
    } else {
      const pad = Object.assign(document.createElement('div'), { className: 'key-grid' });
      pad.append(...DIGITS.flatMap((r) => [...r].map((c) => key(c))), kind === 'phone' ? key('+') : key('', '', 'blank'), key('0'), back);
      dock.replaceChildren(pad, done);
    }
  }

  function type(k) {
    const i = target;
    const s = i.selectionStart ?? i.value.length, e = i.selectionEnd ?? s;
    if (k === 'back') i.setRangeText('', s === e ? Math.max(0, s - 1) : s, e, 'end');
    else {
      const max = i.maxLength > 0 ? i.maxLength : Infinity;
      if (i.value.length - (e - s) + k.length > max) return;
      // Names: a capital letter at the start of each word, like a phone keyboard.
      const cap = dock.dataset.kind === 'letters' && (s === 0 || i.value[s - 1] === ' ');
      i.setRangeText(cap ? k.toLocaleUpperCase(getLang()) : k, s, e, 'end');
    }
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }

  dock.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the field
  dock.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!target || !k) return;
    if (k === 'done') return target.blur();
    type(k);
  });
  document.addEventListener('focusin', (e) => {
    const kind = e.target.dataset?.keys;
    if (!kind) return;
    target = e.target;
    target.inputMode = 'none'; // no OS keyboard on top of ours
    draw(kind);
    dock.hidden = false;
    document.documentElement.classList.add('keypad-open');
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  document.addEventListener('focusout', (e) => {
    if (e.target !== target) return;
    target = null;
    dock.hidden = true;
    document.documentElement.classList.remove('keypad-open');
  });
}
