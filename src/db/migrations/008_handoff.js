// Task 17: per-store order numbers, the kiosk → phone cart handoff, fitting-room requests and the staff Telegram chat.

export async function up(knex) {
  await knex.schema.alterTable('stores', (t) => {
    t.integer('order_seq').notNullable().defaultTo(0); // last order number given out in this store
    t.bigInteger('telegram_chat_id'); // staff chat for fitting-room requests (set in settings, task 19)
  });
  await knex.schema.alterTable('orders', (t) => t.integer('number'));
  // Existing orders get 1, 2, 3… per store in id order.
  for (const { id } of await knex('stores').select('id')) {
    const ids = await knex('orders').where({ store_id: id }).orderBy('id').pluck('id');
    for (const [i, orderId] of ids.entries()) await knex('orders').where({ id: orderId }).update({ number: i + 1 });
    await knex('stores').where({ id }).update({ order_seq: ids.length });
  }
  await knex.schema.alterTable('orders', (t) => t.unique(['store_id', 'number']));
  await knex.schema.alterTable('carts', (t) => {
    t.string('handoff_token', 32).unique(); // one-time, shown as a QR on the kiosk
    t.timestamp('handoff_expires_at');
  });
  await knex.schema.createTable('fitting_requests', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('recommendation_id').references('recommendation_logs.id').onDelete('SET NULL');
    t.integer('cabin').notNullable();
    t.json('items').notNullable(); // [{ product_id, size }]
    t.string('status').notNullable().defaultTo('new');
    t.timestamp('notified_at'); // sent to the store's Telegram chat
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['store_id', 'status']);
    t.check("?? in ('new','done')", ['status'], 'fitting_requests_status_check');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('fitting_requests');
  await knex.schema.alterTable('carts', (t) => {
    t.dropUnique(['handoff_token']);
    t.dropColumn('handoff_expires_at');
    t.dropColumn('handoff_token');
  });
  await knex.schema.alterTable('orders', (t) => {
    t.dropUnique(['store_id', 'number']);
    t.dropColumn('number');
  });
  await knex.schema.alterTable('stores', (t) => {
    t.dropColumn('telegram_chat_id');
    t.dropColumn('order_seq');
  });
}
