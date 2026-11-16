// Task 46: one review per handed-over order line. Tied to the order line only: no phone, no profile, no name (the item
// page shows "Xaridor"). store_id and product_id are copied from the line so the item page and the admin list need no
// join through orders. The unique order_item_id makes a double submit (or two tabs) insert once.
export async function up(knex) {
  await knex.schema.createTable('product_reviews', (t) => {
    t.increments('id');
    t.integer('order_item_id').notNullable().unique().references('order_items.id').onDelete('CASCADE');
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('product_id').notNullable(); // the line's product; order lines keep it, so no FK of its own is needed
    t.integer('rating').notNullable();
    t.string('fit', 10); // small | right | big; null for one-size items (accessories)
    t.string('text', 500);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('hidden_at', { useTz: true });
    t.string('hidden_reason', 200);
    t.integer('hidden_by'); // admin id (the audit row keeps the email)
    t.string('reply', 500);
    t.timestamp('reply_at', { useTz: true });
    t.integer('reply_by');
    t.index(['product_id', 'hidden_at']);
    t.index(['store_id', 'created_at']);
    t.check('?? between 1 and 5', ['rating'], 'product_reviews_rating_check');
    t.check("?? is null or ?? in ('small', 'right', 'big')", ['fit', 'fit'], 'product_reviews_fit_check');
  });
}

export async function down(knex) {
  await knex.schema.dropTable('product_reviews');
}
