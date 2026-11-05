// Portable schema: runs on SQLite (dev/tests) and PostgreSQL (prod).
// All money columns are integer so'm.

export async function up(knex) {
  await knex.schema.createTable('stores', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('city').notNullable();
    t.double('lat').notNullable();
    t.double('lon').notNullable();
    t.string('address').notNullable();
    t.integer('delivery_fee').notNullable().defaultTo(0);
    t.integer('free_delivery_threshold'); // null = delivery never free
    t.timestamps(true, true);
    t.check('?? >= 0', ['delivery_fee'], 'stores_delivery_fee_check');
  });

  await knex.schema.createTable('products', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('category').notNullable();
    t.string('gender').notNullable();
    t.string('color').notNullable();
    t.string('style');
    t.integer('price').notNullable();
    t.integer('discount_price');
    t.integer('temp_min').notNullable();
    t.integer('temp_max').notNullable();
    t.boolean('waterproof').notNullable().defaultTo(false);
    t.string('shelf_location');
    t.string('image_url');
    t.timestamps(true, true);
    t.index(['store_id', 'category']);
    t.check("?? in ('outerwear','top','bottom','shoes','accessory')", ['category'], 'products_category_check');
    t.check("?? in ('male','female','unisex')", ['gender'], 'products_gender_check');
    t.check('?? > 0', ['price'], 'products_price_check');
    t.check('?? is null or (?? > 0 and ?? < ??)', ['discount_price', 'discount_price', 'discount_price', 'price'], 'products_discount_check');
    t.check('?? <= ??', ['temp_min', 'temp_max'], 'products_temp_check');
  });

  await knex.schema.createTable('product_stock', (t) => {
    t.increments('id');
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.string('size').notNullable();
    t.integer('quantity').notNullable().defaultTo(0);
    t.integer('reserved').notNullable().defaultTo(0); // held by carts (task 8)
    t.unique(['product_id', 'size']);
    // Guards against overselling even if app code has a bug.
    t.check('?? >= 0 and ?? >= 0 and ?? <= ??', ['quantity', 'reserved', 'reserved', 'quantity'], 'product_stock_qty_check');
  });

  await knex.schema.createTable('carts', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('token').notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('orders', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id');
    t.integer('cart_id').references('carts.id').onDelete('SET NULL');
    t.string('customer_name').notNullable();
    t.string('phone').notNullable();
    t.string('fulfillment').notNullable();
    t.string('address');
    t.double('lat');
    t.double('lon');
    t.string('status').notNullable().defaultTo('new');
    t.string('payment_status').notNullable().defaultTo('pending');
    t.integer('subtotal').notNullable();
    t.integer('delivery_fee').notNullable().defaultTo(0);
    t.integer('total').notNullable();
    t.timestamps(true, true);
    t.index(['store_id', 'status']);
    t.check("?? in ('pickup','delivery')", ['fulfillment'], 'orders_fulfillment_check');
    t.check("?? in ('new','packing','shipping','delivered','cancelled')", ['status'], 'orders_status_check');
    t.check("?? in ('pending','paid','cancelled')", ['payment_status'], 'orders_payment_status_check');
    t.check('?? >= 0 and ?? >= 0 and ?? = ?? + ??', ['subtotal', 'delivery_fee', 'total', 'subtotal', 'delivery_fee'], 'orders_total_check');
  });

  await knex.schema.createTable('order_items', (t) => {
    t.increments('id');
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id');
    t.string('size').notNullable();
    t.integer('quantity').notNullable();
    t.integer('unit_price').notNullable(); // price at order time
    t.index(['order_id']);
    t.check('?? > 0 and ?? >= 0', ['quantity', 'unit_price'], 'order_items_qty_check');
  });

  await knex.schema.createTable('admins', (t) => {
    t.increments('id');
    t.string('email').notNullable().unique();
    t.string('password_hash').notNullable();
    t.string('role').notNullable();
    t.integer('store_id').references('stores.id').onDelete('CASCADE'); // null for super-admin
    t.timestamps(true, true);
    t.check(
      "(?? = 'super' and ?? is null) or (?? = 'manager' and ?? is not null)",
      ['role', 'store_id', 'role', 'store_id'],
      'admins_role_check',
    );
  });

  // No photo or body data here: only what stats need (task 3).
  await knex.schema.createTable('recommendation_logs', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.double('temperature');
    t.boolean('raining');
    t.string('gender');
    t.json('sizes');
    t.integer('budget');
    t.json('product_ids').notNullable();
    t.string('source').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['store_id', 'created_at']);
    t.check("?? in ('rules','ai')", ['source'], 'recommendation_logs_source_check');
  });
}

export async function down(knex) {
  for (const t of ['recommendation_logs', 'admins', 'order_items', 'orders', 'carts', 'product_stock', 'products', 'stores']) {
    await knex.schema.dropTableIfExists(t);
  }
}
