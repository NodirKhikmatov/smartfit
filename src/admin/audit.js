// Audit log: one row per admin mutation, written in the same transaction as the change it describes.

// Every action the admin API writes (the viewer translates them as adm.act.<action>).
export const AUDIT_ACTIONS = [
  'product.create', 'product.update', 'product.delete', 'product.image', 'product.image_delete',
  'order.status', 'order.pay', 'order.return', 'fitting.done', 'fitting.accept', 'product.fit',
  'store.update', 'store.kiosk_pin', 'team.invite', 'team.invite_revoke', 'team.join', 'team.disable', 'team.enable', 'account.password',
  'sync_key.create', 'sync_key.revoke', 'stock.sync', 'store.create', 'org.create', 'demo.handle', 'promo.create', 'promo.update',
  'category.create', 'category.update', 'category.delete', 'category.image',
  'mall.create', 'mall.update', 'mall.delete', 'mall.logo', 'mall.store', 'org.points', 'points.adjust',
  'offer.create', 'offer.update', 'offer.image', 'offer.submit', 'offer.delete', 'offer.approve', 'offer.reject', 'mall.slides', 'mall.map',
  'org.plan', 'org.checklist', // task 45
  'review.hide', 'review.show', 'review.reply', // task 46
  'stock.open', 'stock.receive', 'stock.close', 'stock.count', // task 47
  'size_chart.save', 'size_chart.delete', // task 48
  'team.commission', // task 50
  'cash.close', // task 51
];
export const AUDIT_ENTITIES = ['product', 'order', 'fitting', 'store', 'team', 'account', 'sync_key', 'stock', 'org', 'demo', 'promo', 'category', 'mall', 'points', 'offer', 'review', 'size_chart', 'cash'];

const json = (v) => (v == null ? null : JSON.stringify(v));

// admin = the acting admin row; storeId = which store's log this belongs to (null for a super-admin's own account).
export async function audit(q, admin, { action, storeId = null, entityId = null, label = null, before = null, after = null }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`);
  await q('audit_log').insert({
    admin_id: admin.id, admin_email: admin.email, store_id: storeId, action, entity: action.split('.')[0],
    entity_id: entityId, entity_label: label == null ? null : String(label).slice(0, 200), before: json(before), after: json(after),
  });
}

// Only the keys whose value changed: { before: { price: 100 }, after: { price: 90 } }, or null when nothing changed.
export function diff(before, after) {
  const b = {}, a = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue;
    b[k] = before[k] ?? null;
    a[k] = after[k] ?? null;
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
