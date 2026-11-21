// Task 41: "O'zimda ko'rish", the AI try-on. A dialog: consent naming the provider (every time) → a photo (kiosk:
// live camera with a countdown; phone: camera or gallery) → waiting → the picture, labelled as approximate.
// The photo and the picture live in this dialog's memory only: the picture is a blob: URL (no CSP change), revoked on
// close; clear() (screen change, "Boshiga", the kiosk idle reset) aborts the request and drops everything.
import { tryonGarment, tryonItem, tryonOutfitItem } from './flow.js';
import { icon, toast } from '/shared/ui.js';
import { t, getLang, productName } from '/shared/i18n.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const PHOTO_PX = 1280, PHOTO_Q = 0.85; // the provider works at 864 × 1296; the server takes ≤ ~1.1 MB
const COUNTDOWN = 3;
const DRAW_PX = 512; // a demo drawing (SVG) is drawn as a PNG this big for an outfit provider (task 58)
const CONSENT = { Gemini: 'kiosk.tryon.consent_gemini' }; // the provider's own terms; FASHN keeps the task 41 text

// Task 58: the demo SVG drawings as PNG data URLs, { id: url }, or undefined when the items all have real photos.
async function drawings(items) {
  const out = {};
  for (const p of items.filter((x) => x.image_url.endsWith('.svg'))) {
    const img = new Image();
    img.src = p.image_url; // same origin: the canvas stays readable
    await img.decode();
    const k = DRAW_PX / Math.max(img.naturalWidth || DRAW_PX, img.naturalHeight || DRAW_PX);
    const c = el('canvas', { width: Math.round((img.naturalWidth || DRAW_PX) * k), height: Math.round((img.naturalHeight || DRAW_PX) * k) });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    out[p.id] = c.toDataURL('image/png');
  }
  return Object.keys(out).length ? out : undefined;
}

// snapshot(source, w, h, maxPx, quality) → a JPEG data URL: app.js's one encoder.
export function createTryon({ storeId, kiosk, snapshot }) {
  let provider = null; // the provider's name when try-on is on in this shop (store info), else null: no buttons
  let outfitMode = false; // task 58: the provider dresses whole outfits (Gemini); else one garment (FASHN)
  // The items one button sends: the whole outfit for an outfit provider, else its most visible usable garment.
  const pick = (items) => (outfitMode ? items.filter(tryonOutfitItem) : [tryonItem(items)].filter(Boolean));
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

  // The button for one item or an outfit (an array), or '' when nothing in it can be used (no photo, a child's item, …).
  // It stays hidden while the shop has try-on off or nothing qualifies for this provider; setProvider shows or hides every
  // button, since the store info may arrive after a page drew.
  function button(items, className = 'ghost wide') {
    items = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (!items.some((p) => tryonGarment(p) || tryonOutfitItem(p))) return '';
    const b = el('button', { type: 'button', className: `${className} tryon-btn`, hidden: !provider || !pick(items).length }, icon('sparkle'), t('kiosk.tryon.btn'));
    b.tryonItems = items;
    b.onclick = () => { const list = pick(items); if (list.length) start(list, b); };
    return b;
  }

  function start(list, opener) {
    const p = list[0];
    const many = list.length > 1;
    clear();
    const dlg = el('dialog', { className: 'tryon' });
    const o = (open = { dlg, ac: new AbortController(), stream: null, timer: null, url: null });
    const h = el('h2', { id: 'tryonTitle', textContent: many ? t('kiosk.tryon.title_outfit') : t('kiosk.tryon.title', { name: productName(p) }) });
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
      step([el('p', { textContent: t(CONSENT[provider] ?? 'kiosk.tryon.consent', { provider }) }), el('p', { className: 'meta', textContent: t('kiosk.tryon.approx') })],
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
        const body = outfitMode ? { store_id: storeId, product_ids: list.map((x) => x.id), photo, consent: true, garments: await drawings(list) }
          : { store_id: storeId, product_id: p.id, photo, consent: true };
        if (open !== o) return;
        const res = await fetch('/api/tryon', {
          method: 'POST', signal: o.ac.signal, headers: { 'accept-language': getLang(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
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
        el('img', { src: o.url, alt: many ? t('kiosk.tryon.alt_outfit') : t('kiosk.tryon.alt', { name: productName(p) }) }),
        el('figcaption', {}, el('span', { className: 'badge', textContent: t('kiosk.tryon.label') }), ' ', t('kiosk.tryon.label_note')))],
      [btn('', t('kiosk.tryon.again'), () => { URL.revokeObjectURL(o.url); o.url = null; consent(); }), btn('primary', t('common.close'), clear)]);
    }
    consent();
  }

  function setProvider(name, outfit = false) {
    provider = name || null;
    outfitMode = !!(provider && outfit);
    if (!provider) clear();
    for (const b of document.querySelectorAll('.tryon-btn')) b.hidden = !provider || !pick(b.tryonItems ?? []).length;
  }
  return { button, clear, setProvider };
}
