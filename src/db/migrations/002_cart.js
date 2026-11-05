// Task 8: cart lines (each holds product_stock.reserved) and order hold/payment fields.

export async function up(knex) {
  await knex.schema.createTable('cart_items', (t) => {
    t.increments('id');
    t.integer('cart_id').notNullable().references('carts.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id');
    t.string('size').notNullable();
    t.integer('quantity').notNullable();
    t.unique(['cart_id', 'product_id', 'size']);
    t.check('?? > 0', ['quantity'], 'cart_items_qty_check');
  });
  await knex.schema.alterTable('orders', (t) => {
    t.string('payment_method').notNullable().defaultTo('cashier'); // task 9 adds click/payme
    t.timestamp('expires_at'); // unpaid hold ends here; null once paid or cancelled
    t.timestamp('paid_at');
    t.index(['payment_status', 'expires_at']);
  });
  await knex.schema.alterTable('carts', (t) => t.index(['expires_at']));
}

export async function down(knex) {
  await knex.schema.alterTable('carts', (t) => t.dropIndex(['expires_at']));
  await knex.schema.alterTable('orders', (t) => {
    t.dropIndex(['payment_status', 'expires_at']);
    t.dropColumn('paid_at');
    t.dropColumn('expires_at');
    t.dropColumn('payment_method');
  });
  await knex.schema.dropTableIfExists('cart_items');
}
