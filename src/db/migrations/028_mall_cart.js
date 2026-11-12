// Task 38: one cart across the shops of a mall. A mall cart is the set of store carts that share carts.mall_token
// (one store cart per shop, so each shop's promo code, points, bundle and holds work exactly as in a single shop).
// Checkout makes one order per shop, tied by an order_groups row with one number per mall and a status page token.
// orders.group_id / group_number: the group, and its number copied for the shop's admin, cashier and staff lists.
export async function up(knex) {
  await knex.schema.alterTable('carts', (t) => {
    t.string('mall_token', 32).index();
    t.integer('mall_id');
  });
  await knex.schema.alterTable('malls', (t) => t.integer('order_seq').notNullable().defaultTo(0));
  await knex.schema.createTable('order_groups', (t) => {
    t.increments('id');
    t.integer('mall_id').notNullable(); // no FK, like the other mall ids (024)
    t.integer('number').notNullable();
    t.string('token', 32).notNullable().unique();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['mall_id', 'number']);
  });
  await knex.schema.alterTable('orders', (t) => {
    t.integer('group_id').index();
    t.integer('group_number');
  });
}

export async function down(knex) {
  // Native DROP COLUMN (see 009); the indexes go first because SQLite refuses to drop an indexed column.
  await knex.schema.alterTable('orders', (t) => t.dropIndex(['group_id']));
  for (const c of ['group_number', 'group_id']) await knex.raw(`alter table orders drop column ${c}`);
  await knex.schema.dropTable('order_groups');
  await knex.raw('alter table malls drop column order_seq');
  await knex.schema.alterTable('carts', (t) => t.dropIndex(['mall_token']));
  for (const c of ['mall_id', 'mall_token']) await knex.raw(`alter table carts drop column ${c}`);
}
