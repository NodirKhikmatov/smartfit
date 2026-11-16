// Task 41: "O'zimda ko'rish", the AI try-on. A dialog: consent naming the provider (every time) → a photo (kiosk:
// live camera with a countdown; phone: camera or gallery) → waiting → the picture, labelled as approximate.
// The photo and the picture live in this dialog's memory only: the picture is a blob: URL (no CSP change), revoked on
// close; clear() (screen change, "Boshiga", the kiosk idle reset) aborts the request and drops everything.
import { tryonGarment } from './flow.js';
import { icon, toast } from '/shared/ui.js';
import { t, getLang, productName } from '/shared/i18n.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const PHOTO_PX = 1280, PHOTO_Q = 0.85; // the provider works at 864 × 1296; the server takes ≤ ~1.1 MB
const COUNTDOWN = 3;

// snapshot(source, w, h, maxPx, quality) → a JPEG data URL: app.js's one encoder.
export function createTryon({ storeId, kiosk, snapshot }) {
  let provider = null; // the provider's name when try-on is on in this shop (store info), else null: no buttons
  let open = null; // the one dialog: { dlg, ac, stream, timer, url }

  function clear() {
    const o = open;
    if (!o) return;
    open = null;
    o.ac.abort();
    clearInterval(o.timer);
    o.stream?.getTracks().forEach((x) => x.stop());
    if (o.url) URL.revokeObjectURL(o.url);
    if (o.dlg.open) o.dlg.close();
    o.dlg.remove();
  }

  // The button for one item, or '' when the item can't be used (no photo, a child's item, …). It stays hidden while
  // the shop has try-on off; setProvider shows or hides every button, since the store info may arrive after a page drew.
  function button(p, className = 'ghost wide') {
    if (!p || !tryonGarment(p)) return '';
    const b = el('button', { type: 'button', className: `${className} tryon-btn`, hidden: !provider }, icon('sparkle'), t('kiosk.tryon.btn'));
    b.onclick = () => start(p, b);
    return b;
  }

  function start(p, opener) {
    clear();
    const dlg = el('dialog', { className: 'tryon' });
    const o = (open = { dlg, ac: new AbortController(), stream: null, timer: null, url: null });
    const h = el('h2', { id: 'tryonTitle', textContent: t('kiosk.tryon.title', { name: productName(p) }) });
    const body = el('div', { className: 'tryon-body' });
    const msg = el('p', { className: 'field-error', role: 'alert' });
    const actions = el('div', { className: 'dialog-actions' });
    dlg.setAttribute('aria-labelledby', h.id);
    dlg.append(h, body, msg, actions);
    dlg.addEventListener('close', () => {
      if (open === o) clear(); // Esc
      if (opener.isConnected) opener.focus();
    });
    document.body.append(dlg);
    dlg.showModal();

    const btn = (className, text, onclick, ic) => el('button', { type: 'button', className, onclick }, ...(ic ? [icon(ic)] : []), text);
    function step(nodes, buttons) {
      msg.textContent = '';
      body.replaceChildren(...nodes);
      actions.replaceChildren(...buttons);
      actions.lastChild?.focus();
    }
    function stopCamera() {
      clearInterval(o.timer);
      o.stream?.getTracks().forEach((x) => x.stop());
      o.stream = null;
    }

    // Asked again before every photo: who gets it, that nothing is kept here and that the picture is approximate.
    function consent() {
      stopCamera();
      step([el('p', { textContent: t('kiosk.tryon.consent', { provider }) }), el('p', { className: 'meta', textContent: t('kiosk.tryon.approx') })],
        [btn('', t('common.cancel'), clear), btn('primary', t('kiosk.tryon.agree'), () => (kiosk ? camera() : picker()))]);
    }

    function picker() {
      const input = (capture) => {
        const i = el('input', { type: 'file', accept: 'image/*', hidden: true });
        if (capture) i.setAttribute('capture', 'user');
        i.onchange = async () => {
          const file = i.files[0];
          i.value = '';
          if (!file || open !== o) return;
          let bmp;
          try {
            bmp = await createImageBitmap(file);
          } catch {
            msg.textContent = t('kiosk.camera.bad_file');
            return;
          }
          const photo = snapshot(bmp, bmp.width, bmp.height, PHOTO_PX, PHOTO_Q);
          bmp.close();
          send(photo);
        };
        return i;
      };
      const cam = input(true), gal = input(false);
      step([el('p', { textContent: t('kiosk.tryon.photo_hint') }), cam, gal],
        [btn('', t('common.cancel'), clear), btn('secondary', t('kiosk.tryon.gallery'), () => gal.click(), 'image'), btn('primary', t('kiosk.tryon.shoot'), () => cam.click(), 'camera')]);
    }

    async function camera() {
      const video = el('video', { muted: true, playsInline: true });
      const count = el('div', { className: 'count' });
      const shoot = btn('primary', t('kiosk.tryon.shoot'), null, 'camera');
      step([el('p', { textContent: t('kiosk.tryon.photo_hint') }), el('div', { className: 'frame live tryon-frame' }, video, count)], [btn('', t('common.cancel'), clear), shoot]);
      shoot.disabled = true;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
        if (open !== o) return s.getTracks().forEach((x) => x.stop()); // closed during the permission prompt
        o.stream = s;
      } catch (err) {
        if (open !== o) return;
        clear(); // back to the normal page, with the reason
        return toast(t(err?.name === 'NotAllowedError' ? 'kiosk.camera.denied' : 'kiosk.camera.broken'), { tone: 'danger', ms: 6000 });
      }
      video.srcObject = o.stream;
      await video.play().catch(() => {});
      shoot.disabled = false;
      shoot.onclick = () => {
        shoot.disabled = true;
        let left = COUNTDOWN;
        count.textContent = left;
        o.timer = setInterval(() => {
          left -= 1;
          count.textContent = left || '';
          if (left > 0 || open !== o) return;
          clearInterval(o.timer);
          const photo = snapshot(video, video.videoWidth, video.videoHeight, PHOTO_PX, PHOTO_Q);
          stopCamera();
          send(photo);
        }, 1000);
      };
    }

    async function send(photo) {
      step([el('p', { className: 'tryon-wait', role: 'status' }, el('span', { className: 'spinner', ariaHidden: 'true' }), t('kiosk.tryon.wait'))], [btn('', t('common.cancel'), clear)]);
      let blob;
      try {
        const res = await fetch('/api/tryon', {
          method: 'POST', signal: o.ac.signal, headers: { 'accept-language': getLang(), 'content-type': 'application/json' },
          body: JSON.stringify({ store_id: storeId, product_id: p.id, photo, consent: true }),
        });
        photo = null;
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('common.error'));
        blob = await res.blob();
      } catch (err) {
        if (open !== o) return; // closed, or the kiosk reset: nothing to say to the next customer
        clear(); // back to the normal page, with the reason
        return toast(err.message || t('common.error'), { tone: 'danger', ms: 6000 });
      }
      if (open !== o) return;
      o.url = URL.createObjectURL(blob);
      step([el('figure', { className: 'tryon-pic' },
        el('img', { src: o.url, alt: t('kiosk.tryon.alt', { name: productName(p) }) }),
        el('figcaption', {}, el('span', { className: 'badge', textContent: t('kiosk.tryon.label') }), ' ', t('kiosk.tryon.label_note')))],
      [btn('', t('kiosk.tryon.again'), () => { URL.revokeObjectURL(o.url); o.url = null; consent(); }), btn('primary', t('common.close'), clear)]);
    }
    consent();
  }

  function setProvider(name) {
    provider = name || null;
    if (!provider) clear();
    for (const b of document.querySelectorAll('.tryon-btn')) b.hidden = !provider;
  }
  return { button, clear, setProvider };
}
