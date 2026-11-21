// Task 41: "O'zimda ko'rish", the AI try-on. A dialog: consent naming the provider (every time) → a photo (kiosk:
// live camera with a countdown; phone: camera or gallery) → waiting → the picture, labelled as approximate.
// The photo and the picture live in this dialog's memory only: the picture is a blob: URL (no CSP change), revoked on
// close; clear() (screen change, "Boshiga", the kiosk idle reset) aborts the request and drops everything.
import { tryonGarment, tryonItem, tryonOutfitItem } from './flow.js';
import { loadPose, track, garmentBox } from './pose.js';
import { icon, toast } from '/shared/ui.js';
import { t, getLang, productName } from '/shared/i18n.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const PHOTO_PX = 1280, PHOTO_Q = 0.85; // the provider works at 864 × 1296; the server takes ≤ ~1.1 MB
const COUNTDOWN = 3;
const DRAW_PX = 512; // a demo drawing (SVG) is drawn as a PNG this big for an outfit provider (task 58)
const CONSENT = { Gemini: 'kiosk.tryon.consent_gemini', 'Hugging Face': 'kiosk.tryon.consent_test' }; // task 59: the test provider // the provider's own terms; FASHN keeps the task 41 text

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
  let roles = null; // task 60: the categories the provider can draw (the free test model: outerwear and tops), null = any
  // The items one button sends: the whole outfit for an outfit provider, else its most visible usable garment.
  const pick = (items) => (outfitMode ? items.filter(tryonOutfitItem) : [tryonItem(items)].filter(Boolean));
  // Task 60: the mirror's rail, every item this provider can put on the photo one by one.
  const railOf = (items) => items.filter((p) => (outfitMode ? tryonOutfitItem(p) : tryonGarment(p)) && (!roles || roles.includes(p.category)));
  let open = null; // the one dialog: { dlg, ac, stream, timer, url }

  function clear() {
    const o = open;
    if (!o) return;
    open = null;
    o.ac.abort();
    clearInterval(o.timer);
    o.stream?.getTracks().forEach((x) => x.stop());
    if (o.url) URL.revokeObjectURL(o.url);
    for (const u of o.urls?.values() ?? []) URL.revokeObjectURL(u); // task 60: the mirror's pictures
    cancelAnimationFrame(o.raf ?? 0); // task 61: the live AR loop
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

  // Task 60/61: "AI ko'zgu", the in-store fitting mirror. Full screen: the live camera (mirrored) with the chosen clothes
  // drawn over the body as it moves (MediaPipe on this device: nothing leaves it), the items down the side; a tap puts an
  // item on or takes it off (one per role). "Haqiqiy ko'rinish (AI)" — only when the shop has a try-on provider — asks
  // the provider's consent, takes one frame and shows the AI picture. Without a camera (or on a phone that refuses it) the
  // mirror falls back to a photo and the AI pictures. Photo, frames and pictures live in this view's memory only and go
  // on close, screen change or the kiosk reset (clear()). addButton(items) → the app's own "Savatga qo'shish".
  const AR_ROLES = ['bottom', 'top', 'outerwear']; // drawing order: trousers under the shirt under the jacket
  const arItem = (p) => (p?.audience ?? 'adult') === 'adult' && AR_ROLES.includes(p?.category ?? '') && /^\/uploads\/products\/[\w-]+\.(jpg|png|webp|svg)$/.test(p?.image_url ?? '');
  const mirrorRail = (items) => items.filter((p) => arItem(p) || railOf([p]).length);

  function mirrorButton(items, addButton) {
    items = items.filter(Boolean);
    if (!mirrorRail(items).length) return '';
    const b = el('button', { type: 'button', className: 'secondary mirror-btn' }, icon('sparkle'), t('kiosk.mirror.btn'));
    b.onclick = () => mirror(mirrorRail(items), b, addButton);
    return b;
  }

  function mirror(list, opener, addButton) {
    clear();
    const dlg = el('dialog', { className: 'mirror' });
    const o = (open = { dlg, ac: new AbortController(), stream: null, timer: null, url: null, urls: new Map(), raf: 0, photo: null, busy: false });
    const worn = new Map(); // role → item on the body
    const pics = new Map(); // item id → a loaded <img> of its picture, for drawing
    const h = el('h2', { id: 'mirrorTitle', textContent: t('kiosk.mirror.title') });
    const close = el('button', { type: 'button', className: 'ghost icon-btn', ariaLabel: t('common.close'), onclick: () => clear() }, icon('close'));
    const stage = el('div', { className: 'mirror-stage' });
    const note = el('p', { className: 'mirror-note', role: 'status' });
    const msg = el('p', { className: 'field-error', role: 'alert' });
    const foot = el('div', { className: 'mirror-foot' });
    const rail = el('div', { className: 'mirror-rail' }, ...list.map((p) => {
      const b = el('button', { type: 'button', className: 'mirror-item', ariaPressed: 'false' }, el('img', { src: p.image_url, alt: '' }), el('span', { textContent: productName(p) }));
      b.onclick = () => (o.photo ? dress(p, b) : toggle(p));
      b.item = p;
      return b;
    }));
    dlg.setAttribute('aria-labelledby', h.id);
    dlg.append(el('div', { className: 'mirror-head' }, h, close), el('div', { className: 'mirror-main' }, el('div', { className: 'mirror-left' }, stage, note, msg), rail), foot);
    dlg.addEventListener('close', () => {
      if (open === o) clear();
      if (opener.isConnected) opener.focus();
    });
    document.body.append(dlg);
    dlg.showModal();

    const btn = (className, text, onclick, ic) => el('button', { type: 'button', className, onclick }, ...(ic ? [icon(ic)] : []), text);
    const show = (nodes, buttons, text = '') => { msg.textContent = ''; note.textContent = text; stage.replaceChildren(...nodes); foot.replaceChildren(...buttons); };
    const items = () => [...rail.children];
    const stopCamera = () => { cancelAnimationFrame(o.raf); clearInterval(o.timer); o.stream?.getTracks().forEach((x) => x.stop()); o.stream = null; };
    const wornList = () => AR_ROLES.map((r) => worn.get(r)).filter(Boolean);
    const sync = () => items().forEach((b) => (b.ariaPressed = String(wornList().includes(b.item))));
    const cart = () => (addButton && wornList().length ? [addButton(wornList())] : []);

    // --- Live AR
    // A demo drawing without its background card (the garment alone, so it sits on the body, not on a tile). A real
    // photo is drawn as it is. shortcut: photos keep their background until shops upload cut-outs.
    function artOf(p) {
      const img = new Image();
      if (!p.image_url.endsWith('.svg')) { img.src = p.image_url; return img; }
      fetch(p.image_url).then((r) => r.text()).then((svg) => {
        if (open !== o) return;
        const url = URL.createObjectURL(new Blob([svg.replace(/<rect width="400" height="400" fill="url\(#bg\)"\/>/, '')], { type: 'image/svg+xml' }));
        o.urls.set(`art-${p.id}`, url); // revoked with the pictures in clear()
        img.src = url;
      }).catch(() => { img.src = p.image_url; });
      return img;
    }
    const video = el('video', { muted: true, playsInline: true, className: 'mirror-live' });
    const canvas = el('canvas', { className: 'mirror-ar' });
    function liveFoot() {
      const ai = provider ? [btn('primary', t('kiosk.mirror.ai'), aiConsent, 'sparkle')] : [];
      foot.replaceChildren(...cart(), ...ai);
    }
    function toggle(p) {
      const role = p.category;
      if (!arItem(p)) return; // shoes and accessories: AI picture only
      worn.get(role) === p ? worn.delete(role) : worn.set(role, p);
      if (!pics.has(p.id)) pics.set(p.id, artOf(p));
      sync();
      liveFoot();
      note.textContent = wornList().length ? wornList().map(productName).join(' + ') : t('kiosk.mirror.live_hint');
    }
    async function live() {
      o.photo = null;
      show([video, canvas], [], t('kiosk.mirror.live_hint'));
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
        if (open !== o) return s.getTracks().forEach((x) => x.stop());
        o.stream = s;
      } catch (err) {
        if (open !== o) return;
        if (err?.name === 'NotAllowedError' || kiosk) { clear(); return toast(t(err?.name === 'NotAllowedError' ? 'kiosk.camera.denied' : 'kiosk.camera.broken'), { tone: 'danger', ms: 6000 }); }
        return provider ? aiConsent() : clear(); // a phone without a camera: the photo path, if there is a provider
      }
      video.srcObject = o.stream;
      await video.play().catch(() => {});
      loadPose().catch(() => { msg.textContent = t('kiosk.camera.failed'); });
      liveFoot();
      const g = canvas.getContext('2d');
      const smooth = new Map(); // role → last box, eased so the clothes don't jitter
      let busy = false;
      const frame = async () => {
        if (open !== o || !o.stream) return;
        o.raf = requestAnimationFrame(frame);
        if (busy || !video.videoWidth) return;
        busy = true;
        try {
          const lm = wornList().length ? await track(video) : null;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          g.clearRect(0, 0, canvas.width, canvas.height);
          for (const p of wornList()) {
            const box = garmentBox(lm, p.category, canvas.width, canvas.height);
            const img = pics.get(p.id);
            if (!box || !img?.complete) { smooth.delete(p.category); continue; }
            const prev = smooth.get(p.category);
            const k = 0.45; // ease toward the new box
            const b = prev ? Object.fromEntries(Object.keys(box).map((key) => [key, prev[key] + (box[key] - prev[key]) * k])) : box;
            smooth.set(p.category, b);
            g.save();
            g.translate(b.x, b.y);
            g.rotate(b.angle);
            g.drawImage(img, -b.ox * b.w, -b.oy * b.h, b.w, b.h);
            g.restore();
          }
        } catch { /* a dropped frame */ } finally {
          busy = false;
        }
      };
      o.raf = requestAnimationFrame(frame);
    }

    // --- The AI picture (the provider's consent every time, then one frame or a photo)
    function aiConsent() {
      const fromLive = !!o.stream;
      foot.replaceChildren();
      stage.append(el('div', { className: 'mirror-wait mirror-text' }, el('div', {},
        el('p', { textContent: t(CONSENT[provider] ?? 'kiosk.tryon.consent', { provider }) }), el('p', { className: 'meta', textContent: t('kiosk.tryon.approx') }))));
      foot.replaceChildren(btn('', t('common.cancel'), () => (fromLive ? (stage.querySelector('.mirror-wait')?.remove(), liveFoot()) : clear())),
        btn('primary', t('kiosk.tryon.agree'), () => (fromLive ? countdown() : picker())));
      foot.lastChild.focus();
    }
    function countdown() {
      stage.querySelector('.mirror-wait')?.remove();
      const count = el('div', { className: 'count' });
      stage.append(count);
      foot.replaceChildren();
      let left = COUNTDOWN;
      count.textContent = left;
      o.timer = setInterval(() => {
        left -= 1;
        count.textContent = left || '';
        if (left > 0 || open !== o) return;
        clearInterval(o.timer);
        count.remove();
        const photo = snapshot(video, video.videoWidth, video.videoHeight, PHOTO_PX, PHOTO_Q);
        aiPicture(photo);
      }, 1000);
    }
    function picker() {
      const i = el('input', { type: 'file', accept: 'image/*', hidden: true });
      i.onchange = async () => {
        const file = i.files[0];
        i.value = '';
        if (!file || open !== o) return;
        let bmp;
        try { bmp = await createImageBitmap(file); } catch { msg.textContent = t('kiosk.camera.bad_file'); return; }
        const photo = snapshot(bmp, bmp.width, bmp.height, PHOTO_PX, PHOTO_Q);
        bmp.close();
        o.photo = photo;
        show([el('img', { className: 'mirror-pic', src: photo, alt: t('kiosk.mirror.yours') })], [btn('', t('common.close'), clear)], t('kiosk.mirror.pick'));
      };
      show([el('div', { className: 'mirror-text' }, el('p', { textContent: t('kiosk.tryon.photo_hint') })), i], [btn('', t('common.cancel'), clear), btn('primary', t('kiosk.tryon.gallery'), () => i.click(), 'image')]);
    }
    // From the live mirror: the clothes on the body now (an outfit provider takes them all, else the outer upper one).
    async function aiPicture(photo) {
      const chosen = wornList().length ? wornList() : list.filter((p) => railOf([p]).length).slice(0, 1);
      const send = railOf(chosen);
      if (!send.length) { msg.textContent = t('kiosk.mirror.ai_none'); return liveFoot(); }
      await request(outfitMode ? send : [tryonItem(send) ?? send[0]], photo, send.map(productName).join(' + '));
    }
    // From a photo (no camera): one item per tap.
    async function dress(p, b) {
      if (o.busy) return;
      items().forEach((x) => (x.ariaPressed = String(x === b)));
      if (o.urls.has(p.id)) return picture(o.urls.get(p.id), productName(p), [p]);
      await request([p], o.photo, productName(p));
    }
    function picture(url, name, picked) {
      show([el('figure', { className: 'mirror-fig' }, el('img', { className: 'mirror-pic', src: url, alt: t('kiosk.tryon.alt', { name }) }),
        el('figcaption', {}, el('span', { className: 'badge', textContent: t('kiosk.tryon.label') }), ' ', t('kiosk.tryon.label_note')))],
      [...(addButton ? [addButton(picked)] : []), ...(o.photo ? [] : [btn('primary', t('kiosk.mirror.back_live'), backLive, 'camera')])], name);
    }
    function backLive() {
      show([video, canvas], [], wornList().length ? wornList().map(productName).join(' + ') : t('kiosk.mirror.live_hint'));
      liveFoot();
    }
    async function request(picked, photo, name) {
      o.busy = true;
      stage.append(el('div', { className: 'mirror-wait', role: 'status' }, el('span', { className: 'spinner', ariaHidden: 'true' }), t('kiosk.mirror.loading', { name })));
      foot.replaceChildren();
      try {
        const key = picked.map((p) => p.id).join('+');
        if (!o.urls.has(key)) {
          const body = outfitMode ? { store_id: storeId, product_ids: picked.map((p) => p.id), photo, consent: true, garments: await drawings(picked) }
            : { store_id: storeId, product_id: picked[0].id, photo, consent: true };
          const res = await fetch('/api/tryon', { method: 'POST', signal: o.ac.signal, headers: { 'accept-language': getLang(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('common.error'));
          const blob = await res.blob();
          if (open !== o) return;
          o.urls.set(key, URL.createObjectURL(blob));
        }
        if (open !== o) return;
        picture(o.urls.get(key), name, picked);
      } catch (err) {
        if (open !== o) return;
        stage.querySelector('.mirror-wait')?.remove();
        msg.textContent = err.message || t('common.error');
        if (o.photo) foot.replaceChildren(btn('', t('common.close'), clear)); else liveFoot();
      } finally {
        o.busy = false;
      }
    }
    live();
  }

  function setProvider(name, outfit = false, canDraw = null) {
    provider = name || null;
    outfitMode = !!(provider && outfit);
    roles = provider && Array.isArray(canDraw) ? canDraw : null;
    if (!provider) clear();
    for (const b of document.querySelectorAll('.tryon-btn')) b.hidden = !provider || !pick(b.tryonItems ?? []).length;
  }
  return { button, mirrorButton, clear, setProvider };
}
