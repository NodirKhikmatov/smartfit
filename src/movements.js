// Task 47: one stock movement row per change of product_stock.quantity. Called right after the caller's UPDATE, inside
// its transaction: the row is locked by that UPDATE, so the quantity read here is the one it wrote.
// A leaf module (no imports), so cart.js can use it without an import cycle.
// who = the admin row ({ id, email }), or null (a customer's payment); ref = { session_id?, order_id?, transfer_id? }.
export async function moved(trx, { productId, size, delta, reason, who = null, ref = {} }) {
  if (!delta) return;
  const row = await trx('product_stock as ps').join('products as p', 'p.id', 'ps.product_id')
    .where({ 'ps.product_id': productId, 'ps.size': size }).first('ps.quantity', 'p.store_id');
  if (!row) return;
  await trx('stock_movements').insert({ store_id: row.store_id, product_id: productId, size, delta, quantity_before: row.quantity - delta, quantity_after: row.quantity,
    reason, admin_id: who?.id ?? null, admin_email: who?.email ?? null, session_id: ref.session_id ?? null, order_id: ref.order_id ?? null, transfer_id: ref.transfer_id ?? null });
}
