// Kiosk idle reset: calls onIdle once after timeoutMs with no user activity on target.
export const IDLE_MS = 90_000;
const EVENTS = ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'];

export function watchIdle(target, { onIdle, timeoutMs = IDLE_MS }) {
  let timer;
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(onIdle, timeoutMs);
  };
  for (const e of EVENTS) target.addEventListener(e, poke, { passive: true });
  poke();
  return () => {
    clearTimeout(timer);
    for (const e of EVENTS) target.removeEventListener(e, poke);
  };
}
