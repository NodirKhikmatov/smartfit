// Task 36: a fixed grid of demo-store answers (whole outfits, single items, catalogue) reduced to product ids, totals and
// fallbacks, so a test can prove that per-shop categories changed nothing for the demo stores. It talks HTTP only, so
// the same file ran against the code before task 36 to make test/fixtures/demo-recommendations.json.
export const WEATHERS = [[-10, false], [5, false], [15, false], [17, true], [30, false]];
const ROLES = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
const SIZES = [['S', 'S', '39'], ['M', 'L', '42'], ['XL', 'XL', null]];

export async function demoGrid(base, setWeather, want = (role) => [role]) {
  const send = (path, body) => fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
  const ids = (items) => items.map((i) => i.id);
  const out = {};
  for (const [temperature, raining] of WEATHERS) {
    setWeather({ temperature, apparent_temperature: temperature, raining, wind_speed: 2, source: 'live' });
    for (const store of [1, 2]) {
      for (const gender of ['male', 'female']) {
        for (const [top, bottom, shoes] of SIZES) {
          for (const budget of [null, 900000]) {
            const r = await send('/api/recommend', { store_id: store, gender, sizes: { top, bottom, shoes }, budget });
            out[`outfit ${temperature}${raining ? ' rain' : ''} s${store} ${gender} ${top}/${bottom}/${shoes} ${budget}`] = {
              outfits: r.outfits.map((o) => [ids(o.items), o.total, o.alternative && ids(o.alternative.items)]),
              partial: r.partial && ids(r.partial.items), relaxed: r.relaxed, notice: r.notice, over: r.over_budget,
            };
          }
        }
        for (const role of ROLES) {
          const r = await send('/api/recommend', { store_id: store, gender, sizes: { top: 'M', bottom: 'L', shoes: '42' }, want: await want(role, store) });
          out[`single ${temperature}${raining ? ' rain' : ''} s${store} ${gender} ${role}`] = r.groups.map((g) => g.items.map((i) => [i.id, i.size, i.sizes ?? null, i.alternative?.id ?? null, ids(i.pairs)]));
        }
      }
    }
  }
  for (const store of [1, 2]) {
    out[`catalog s${store}`] = ids((await send(`/api/catalog/${store}`)).items);
    for (const role of ROLES) out[`catalog s${store} ${role}`] = ids((await send(`/api/catalog/${store}?category=${role}`)).items);
  }
  return out;
}
