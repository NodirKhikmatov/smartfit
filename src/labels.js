// Task 32: QR labels on garments. A label holds /q/<store>/<product>; the phone's own camera opens it, this logs the
// scan and sends the phone to that item's page in the customer app (/m?store=&item=&scan=). No in-app scanner.
// The scan log holds no personal data: store, product, time and a random token (the item page's fitting-room request).
import { randomBytes } from 'node:crypto';
import { dbTime } from './recommend/routes.js';

const posInt = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647; // a larger id would make Postgres throw (integer column)
const iso = (ms) => new Date(ms).toISOString(); // paid_at is written as an ISO string (cart.js)

export const labelPath = (storeId, productId) => `/q/${storeId}/${productId}`;

// GET /q/:store/:product → 302. Logged only when the product is that store's and has a size with free stock (the item
// page shows it); otherwise the phone still lands on the item page, which says it is sold out. HEAD (link previews)
// and requests over the rate limit are not logged, but still redirected: a customer never sees a 429 from a label.
export function createScanRoute(db, { limit = (req, res, next) => next() } = {}) {
  return async (req, res) => {
    const store = Number(req.params.store), id = Number(req.params.product);
    if (!posInt(store)) return res.redirect(302, '/m');
    if (!posInt(id)) return res.redirect(302, `/m?store=${store}`);
    let counted = req.method === 'GET';
    if (counted) {
      try {
        limit(req, res, () => {});
      } catch {
        counted = false;
        res.removeHeader('Retry-After');
      }
    }
    const visible = counted && (await db('products as p').where({ 'p.id': id, 'p.store_id': store })
      .whereExists(db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0')).first('p.id'));
    let scan = '';
    if (visible) {
      const token = randomBytes(16).toString('hex');
      await db('qr_scans').insert({ token, store_id: store, product_id: id });
      scan = `&scan=${token}`;
    }
    res.set('Cache-Control', 'no-store').redirect(302, `/m?store=${store}&item=${id}${scan}`);
  };
}

// Talab report: products scanned in [from, now) with the units sold in the same window, the ones scanned most and
// bought least first (scans − sold). `sold` counts every paid, not cancelled sale of the product, not only after a scan.
export async function scanStats(db, scope, { from, limit = 50 }) {
  const rows = await scope(db('qr_scans as q'), 'q.store_id').where('q.created_at', '>=', dbTime(from))
    .join('products as p', 'p.id', 'q.product_id').join('stores as st', 'st.id', 'q.store_id').leftJoin('categories as c', 'c.id', 'p.category_id')
    .groupBy('q.product_id', 'p.name', 'p.name_ru', 'p.category', 'c.name', 'c.name_ru', 'p.sku', 'q.store_id', 'st.name')
    .select('q.product_id', 'p.name', 'p.name_ru', 'p.category', 'c.name as category_name', 'c.name_ru as category_name_ru', 'p.sku', 'q.store_id', 'st.name as store_name').count({ scans: '*' });
  if (!rows.length) return [];
  const sold = await db('order_items as i').join('orders as o', 'o.id', 'i.order_id').where('o.paid_at', '>=', iso(from))
    .whereIn('i.product_id', rows.map((x) => x.product_id)).where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
    .groupBy('i.product_id').select('i.product_id').sum({ units: 'i.quantity' });
  const soldBy = new Map(sold.map((x) => [x.product_id, Number(x.units)]));
  return rows.map((x) => {
    const scans = Number(x.scans), units = soldBy.get(x.product_id) ?? 0;
    return { ...x, scans, sold: units, rate: Math.round((Math.min(units, scans) / scans) * 100) };
  }).sort((a, b) => b.scans - b.sold - (a.scans - a.sold) || b.scans - a.scans || a.product_id - b.product_id).slice(0, limit);
}
