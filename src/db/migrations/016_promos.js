// Task 26: promo codes and the "whole outfit" bundle discount.
// promo_codes.used counts live orders that took the code; checkout claims it with a conditional UPDATE and a cancelled
// or expired order gives it back. recommendation_logs.outfits keeps the outfits a results screen showed, so the cart
// can tell a real recommended outfit (bundle) from any set of items. order_items.discount = this line's share of the
// order's discounts, so a return refunds what the customer actually paid.
// orders_total_check becomes total = subtotal − bundle − promo + delivery. SQLite can't alter a CHECK, so orders is
// rebuilt the documented 12-step way with foreign keys off (as in 012), hence no knex transaction around it.
export const config = { transaction: false };

const OLD_CHECK = 'subtotal >= 0 and delivery_fee >= 0 and total = subtotal + delivery_fee';
export const NEW_CHECK = 'subtotal >= 0 and delivery_fee >= 0 and bundle_discount >= 0 and promo_discount >= 0'
  + ' and bundle_discount + promo_discount <= subtotal and total = subtotal - bundle_discount - promo_discount + delivery_fee';
const isPg = (knex) => knex.client.config.client === 'pg';

export async function withFksOff(knex, fn) {
  if (isPg(knex)) return knex.transaction(fn);
  await knex.raw('pragma foreign_keys = off');
  try {
    await knex.transaction(fn);
    const broken = await knex.raw('pragma foreign_key_check');
    if (broken.length) throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
  } finally {
    await knex.raw('pragma foreign_keys = on');
  }
}

// Swaps the orders total CHECK. SQLite: same table SQL with the new CHECK, rows copied, swapped in, indexes recreated.
export async function setTotalCheck(trx, from, to) {
  if (isPg(trx)) {
    await trx.raw('alter table orders drop constraint orders_total_check');
    return trx.raw(`alter table orders add constraint orders_total_check check (${to})`);
  }
  // knex wrote the table with backtick-quoted names; the plain names are simple identifiers, so the quotes can go.
  const sql = (await trx.raw("select sql from sqlite_master where type = 'table' and name = 'orders'"))[0].sql.replace(/\x60/g, ''); // \x60 = backtick
  if (!sql.includes(from)) throw new Error('orders_total_check is not the expected one');
  const indexes = (await trx.raw("select sql from sqlite_master where type = 'index' and tbl_name = 'orders' and sql is not null")).map((i) => i.sql);
  await trx.raw(sql.replace(from, to).replace(/^CREATE TABLE "orders"/, 'CREATE TABLE "orders_v2"'));
  await trx.raw('insert into orders_v2 select * from orders');
  await trx.raw('drop table orders');
  await trx.raw('alter table orders_v2 rename to orders');
  for (const i of indexes) await trx.raw(i);
}

export const up = (knex) => withFksOff(knex, async (knex) => {
  await knex.schema.createTable('promo_codes', (t) => {
    t.increments('id');
    t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE'); // null = every store of the organisation
    t.string('code', 32).notNullable(); // upper case
    t.string('kind').notNullable();
    t.integer('value').notNullable(); // percent 1–100, or so'm
    t.integer('min_order').notNullable().defaultTo(0);
    t.timestamp('starts_at');
    t.timestamp('ends_at');
    t.integer('max_uses');
    t.integer('max_per_phone');
    t.integer('used').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['organization_id', 'code']);
    t.check("?? in ('percent','fixed')", ['kind'], 'promo_codes_kind_check');
  });
  await knex.schema.alterTable('stores', (t) => t.integer('bundle_percent').notNullable().defaultTo(0));
  await knex.schema.alterTable('recommendation_logs', (t) => t.json('outfits'));
  await knex.schema.alterTable('carts', (t) => {
    t.integer('promo_code_id'); // no FK (SQLite can't drop an FK column in down); codes are never deleted, only switched off
    t.json('bundles'); // [[product_id, …], …]: recommended outfits added whole
  });
  await knex.schema.alterTable('orders', (t) => {
    t.integer('promo_code_id'); // no FK, as on carts; promo_code keeps the text
    t.string('promo_code', 32);
    t.integer('promo_discount').notNullable().defaultTo(0);
    t.integer('bundle_discount').notNullable().defaultTo(0);
    t.index(['promo_code_id', 'phone']);
  });
  await knex.schema.alterTable('order_items', (t) => t.integer('discount').notNullable().defaultTo(0));
  await setTotalCheck(knex, OLD_CHECK, NEW_CHECK);
});

export const down = (knex) => withFksOff(knex, async (knex) => {
  // Discounts folded into the subtotal (one UPDATE, so both CHECKs hold), then the old CHECK comes back.
  await knex('orders').update({ subtotal: knex.raw('total - delivery_fee'), bundle_discount: 0, promo_discount: 0 });
  await setTotalCheck(knex, NEW_CHECK, OLD_CHECK);
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('alter table order_items drop column discount');
  await knex.schema.alterTable('orders', (t) => t.dropIndex(['promo_code_id', 'phone']));
  for (const c of ['bundle_discount', 'promo_discount', 'promo_code', 'promo_code_id']) await knex.raw(`alter table orders drop column ${c}`);
  for (const c of ['bundles', 'promo_code_id']) await knex.raw(`alter table carts drop column ${c}`);
  await knex.raw('alter table recommendation_logs drop column outfits');
  await knex.raw('alter table stores drop column bundle_percent');
  await knex.schema.dropTable('promo_codes');
});
