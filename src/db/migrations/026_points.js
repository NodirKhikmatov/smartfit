// Task 34: cashback points. One organisation's points are integer so'm in points_ledger; a balance is the sum of its
// rows. Every row has a unique `ref` naming the one order or return it belongs to ('earn:<order>', 'spend:<order>',
// 'refund:<order>', 'clawback:<return>', 'return:<return>'), so a repeated status change or a race can't write it twice.
// organizations: cashback_percent (0 = off) and points_max_share (the largest % of the goods points may pay).
// orders.points_discount = points spent on the order: the total CHECK becomes
// total = subtotal − bundle − promo − points + delivery (rebuilt like 016). orders.profile_id = the profile that logged
// in at checkout (no FK: "delete my data" clears it). order_items.points = the line's share of points_discount (also
// counted in order_items.discount, so a return refunds only the money paid). carts.profile_id = the profile that
// confirmed "use my points" in Telegram for this cart.
import { withFksOff, setTotalCheck, NEW_CHECK as PROMO_CHECK } from './016_promos.js';

export const config = { transaction: false };

const POINTS_CHECK = 'subtotal >= 0 and delivery_fee >= 0 and bundle_discount >= 0 and promo_discount >= 0 and points_discount >= 0'
  + ' and bundle_discount + promo_discount + points_discount <= subtotal'
  + ' and total = subtotal - bundle_discount - promo_discount - points_discount + delivery_fee';

export const up = (knex) => withFksOff(knex, async (knex) => {
  await knex.schema.alterTable('organizations', (t) => {
    t.integer('cashback_percent').notNullable().defaultTo(0);
    t.integer('points_max_share').notNullable().defaultTo(50);
  });
  await knex.schema.alterTable('orders', (t) => {
    t.integer('points_discount').notNullable().defaultTo(0);
    t.integer('profile_id');
  });
  await knex.schema.alterTable('order_items', (t) => t.integer('points').notNullable().defaultTo(0));
  await knex.schema.alterTable('carts', (t) => t.integer('profile_id'));
  await setTotalCheck(knex, PROMO_CHECK, POINTS_CHECK);
  await knex.schema.createTable('points_ledger', (t) => {
    t.increments('id');
    t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('profile_id').notNullable().references('customer_profiles.id').onDelete('CASCADE');
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.string('kind', 10).notNullable();
    t.integer('amount').notNullable(); // so'm, + earned or given back, − spent or taken back
    t.string('ref', 40).notNullable().unique();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['profile_id']);
    t.index(['order_id']);
    t.check("?? in ('earn','spend','refund','clawback','return')", ['kind'], 'points_ledger_kind_check');
  });
});

export const down = (knex) => withFksOff(knex, async (knex) => {
  await knex.schema.dropTable('points_ledger');
  // Points folded into the subtotal (one UPDATE, so both CHECKs hold), then 016's CHECK comes back.
  await knex('orders').update({ subtotal: knex.raw('subtotal - points_discount'), points_discount: 0 });
  await setTotalCheck(knex, POINTS_CHECK, PROMO_CHECK);
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('alter table carts drop column profile_id');
  await knex.raw('alter table order_items drop column points');
  for (const c of ['profile_id', 'points_discount']) await knex.raw(`alter table orders drop column ${c}`);
  for (const c of ['points_max_share', 'cashback_percent']) await knex.raw(`alter table organizations drop column ${c}`);
});
