// Current weather per store from Open-Meteo, cached 10 min; offline → monthly average.

export const CACHE_MS = 10 * 60 * 1000;
const FALLBACK_CACHE_MS = 60 * 1000; // retry Open-Meteo soon, but don't make every kiosk request wait for a timeout
const TIMEOUT_MS = 3000;

// shortcut: one table of Tashkent climate normals (°C, Jan–Dec) for every store; add per-city tables if stores open outside Uzbekistan's lowlands.
export const MONTHLY_AVG = [3, 5, 11, 17, 22, 27, 29, 28, 22, 15, 9, 4];

// WMO weather codes for drizzle, rain, freezing rain, showers and thunderstorms.
const RAIN_CODE = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

export function fallbackWeather(nowMs) {
  const month = new Date(nowMs + 5 * 3600000).getUTCMonth(); // Asia/Tashkent is UTC+5, no DST
  return { temperature: MONTHLY_AVG[month], apparent_temperature: null, raining: false, wind_speed: null, source: 'fallback' };
}

export function createWeather({ fetch = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async function getWeather({ lat, lon }) {
    const key = `${lat},${lon}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    let value, ttl;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const c = (await res.json()).current;
      if (!Number.isFinite(c?.temperature_2m)) throw new Error('Open-Meteo: no temperature');
      value = {
        temperature: c.temperature_2m,
        apparent_temperature: c.apparent_temperature ?? null,
        raining: c.precipitation > 0 || RAIN_CODE(c.weather_code),
        wind_speed: c.wind_speed_10m ?? null,
        source: 'live',
      };
      ttl = CACHE_MS;
    } catch (err) {
      console.warn(`Weather fallback: ${err.message}`);
      value = fallbackWeather(now());
      ttl = FALLBACK_CACHE_MS;
    }
    cache.set(key, { value, until: now() + ttl });
    return value;
  };
}
