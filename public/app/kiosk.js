// Kiosk PWA shell (task 21): service worker + manifest, fullscreen and screen wake lock, the attract loop after idle,
// the staff exit PIN (long-press the logo), and a heartbeat for "online / last seen" in admin.
import { t } from '/shared/i18n.js';
import { toast } from '/shared/ui.js';

export const PING_MS = 60_000;
const HOLD_MS = 3000; // long-press on the logo that opens the staff PIN dialog
const $ = (id) => document.getElementById(id);

export function kioskShell({ storeId, api }) {
  let staff = false; // after a correct PIN: no fullscreen or wake lock until the page is reloaded
  let lock = null;

  if (storeId > 0) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'manifest', href: `/kiosk.webmanifest?store=${storeId}` }));
  }
  navigator.serviceWorker?.register('/kiosk-sw.js', { scope: '/kiosk' }).catch(() => {}); // offline shell is a bonus, never a blocker

  // Fullscreen needs a user gesture, so every touch re-enters it (e.g. after a staff member pressed Esc on a keyboard).
  const wake = async () => {
    if (staff || lock || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch {} // no API or not allowed: the OS power settings decide
  };
  document.addEventListener('visibilitychange', wake);
  wake();
  document.addEventListener('pointerdown', () => {
    attract(false);
    if (!staff && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  }, { capture: true, passive: true });
  document.addEventListener('keydown', () => attract(false), { capture: true });

  const device = kioskDevice();
  const ping = () => storeId > 0 && device && api('/kiosk/ping', { store_id: storeId, device }).catch(() => {});
  ping();
  setInterval(ping, PING_MS);

  // Staff exit: hold the logo for 3 s, then the store's PIN (set in admin → Sozlamalar → Do'kon).
  const dlg = $('staffDlg'), f = $('staffForm');
  let timer;
  const logo = document.querySelector('.topbar .wordmark');
  logo.addEventListener('pointerdown', () => { timer = setTimeout(openPin, HOLD_MS); });
  for (const e of ['pointerup', 'pointerleave', 'pointercancel']) logo.addEventListener(e, () => clearTimeout(timer));
  logo.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press must not open the browser menu

  function openPin() {
    f.reset();
    $('staffErr').textContent = '';
    f.pin.removeAttribute('aria-invalid');
    dlg.showModal();
    dlg.append(document.querySelector('.keypad')); // a modal makes the page inert, so the on-screen digits move inside it
    f.pin.focus();
  }
  dlg.addEventListener('close', () => document.body.append(document.querySelector('.keypad')));
  $('staffCancel').onclick = () => dlg.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const pin = f.pin.value;
    $('staffGo').disabled = true;
    try {
      await api('/kiosk/exit', { store_id: storeId, pin });
      staff = true;
      dlg.close();
      await lock?.release().catch(() => {});
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      toast(t('kiosk.staff.done'), { tone: 'ok' });
    } catch (err) {
      $('staffErr').textContent = err.message;
      f.pin.setAttribute('aria-invalid', 'true');
      f.pin.value = '';
      f.pin.focus();
    } finally {
      $('staffGo').disabled = false;
    }
  };
}

// Heartbeat id: random per kiosk device, kept in localStorage (not personal data). Also tags the funnel events (task 24).
export const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
export function kioskDevice() {
  let device = null;
  try {
    device = localStorage.getItem('sfKiosk');
    if (!/^[a-f0-9]{32}$/.test(device ?? '')) localStorage.setItem('sfKiosk', (device = randomId()));
  } catch {}
  return device;
}

// Attract loop: the start screen slowly cycles through today's looks until someone touches the screen.
export function attract(on) {
  document.documentElement.classList.toggle('attract-loop', on);
}
