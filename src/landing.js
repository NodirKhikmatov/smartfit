// Task 22: the landing page at / and the live data its outfit fragment shows. The fragment runs the real outfit engine
// (buildOutfits) over the demo catalogue of the Toshkent demo store, so the page shows what the kiosk would pick.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, IMAGE_DIR } from './db/seed.js';
import { buildOutfits, unitPrice } from './recommend/engine.js';
import { qrSvg, publicBase } from './qr.js';

export const LANDING_TEMPS = [-10, 5, 15, 30];
const SHELF = 'ABCDE';

// One outfit per preset temperature (a man's, any size): { t, items: [{ sku, name, name_ru, category, color, price, unit_price, shelf, image }] }.
export function landingLooks() {
  const pool = CATALOGUE.map((p, i) => ({ ...p, id: i + 1, shelf_location: `${SHELF[i % 5]}-${i + 1}`, unit_price: unitPrice(p) }))
    .filter((p) => p.stores.includes('T') && p.gender !== 'female');
  return LANDING_TEMPS.map((t) => {
    const fits = pool.filter((p) => p.temp_min <= t && p.temp_max >= t);
    const [outfit] = buildOutfits(fits, { temperature: t, raining: false }).outfits;
    return {
      t,
      items: (outfit?.items ?? []).map((p) => ({ sku: p.sku, name: p.name, name_ru: p.name_ru, category: p.category, color: p.color, price: p.price,
        unit_price: p.unit_price, shelf: p.shelf_location, image: `/landing/looks/${p.sku}.svg` })),
    };
  });
}

export function createLandingRouter() {
  const r = express.Router();
  const dir = fileURLToPath(new URL('../public/landing', import.meta.url));
  const looks = JSON.stringify(landingLooks());
  r.get('/', (req, res) => res.sendFile('index.html', { root: dir }));
  r.get('/landing/looks.json', (req, res) => res.type('json').set('Cache-Control', 'public, max-age=3600').send(looks));
  // The demo store's phone QR, as printed by the onboarding wizard.
  r.get('/landing/qr.svg', (req, res) => res.type('image/svg+xml').send(qrSvg(`${publicBase(req)}/m?store=1`, 8)));
  r.use('/landing/looks', express.static(IMAGE_DIR, { index: false, maxAge: '7d' })); // the demo catalogue's drawings
  r.use('/landing', express.static(dir, { index: false }));
  return r;
}
