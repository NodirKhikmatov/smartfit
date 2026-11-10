// Task 31: "Kelganda xabar bering". A customer with a Telegram profile waits for one product size; the notifier sends
// one message when it has free stock again and sets notified_at. Deleting the profile (or the product) deletes these.
export async function up(knex) {
  await knex.schema.createTable('stock_alerts', (t) => {
    t.increments('id');
    t.integer('profile_id').notNullable().references('customer_profiles.id').onDelete('CASCADE');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE'); // the product's store (admin scope)
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.string('size', 8).notNullable();
    t.string('lang', 2).notNullable().defaultTo('uz'); // the screen's language when asked: the message goes in it
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('notified_at'); // null = still waiting
    t.unique(['profile_id', 'product_id', 'size']);
    t.index(['product_id', 'size']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('stock_alerts');
}
