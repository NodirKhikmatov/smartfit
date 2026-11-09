// Task 25: "reserve it in another store". Such an order is made without a cart, so the per-client cap on held stock
// (task 21, carts.client) needs the same hashed client key on the order.
export async function up(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.string('client', 16); // clientKey(ip) of a cross-store reservation; null for normal checkouts
  });
}

export async function down(knex) {
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('alter table orders drop column client');
}
