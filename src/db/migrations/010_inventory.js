// Task 20: SKU unique per store, optional barcode, per-store low-stock threshold with once-per-crossing alerts,
// and per-store API keys for the stock sync endpoint (only their sha256 is stored).
export async function up(knex) {
  await knex.schema.alterTable('products', (t) => {
    t.string('barcode', 40);
    t.unique(['store_id', 'sku'], { indexName: 'products_store_sku_unique' }); // nulls don't clash on either database
  });
  await knex.schema.alterTable('stores', (t) => {
    t.integer('low_stock_threshold').notNullable().defaultTo(1); // a size with this many free units or fewer is running out
  });
  await knex.schema.alterTable('product_stock', (t) => {
    t.boolean('low_alerted').notNullable().defaultTo(false); // the staff chat was told; reset once the size is above the threshold again
  });
  // What is already low is on the dashboard; only crossings from now on go to Telegram (no flood on deploy).
  await knex('product_stock').whereIn('id', knex('product_stock as ps').join('products as p', 'p.id', 'ps.product_id')
    .join('stores as s', 's.id', 'p.store_id').whereRaw('ps.quantity - ps.reserved <= s.low_stock_threshold').select('ps.id'))
    .update({ low_alerted: true });
  await knex.schema.createTable('sync_keys', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('name', 60).notNullable();
    t.string('key_hash', 64).notNullable().unique(); // sha256 of the key; the key is shown once and never stored
    t.string('prefix', 12).notNullable(); // first characters, so the owner can tell keys apart
    t.integer('created_by').references('admins.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at');
    t.timestamp('revoked_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('sync_keys');
  await knex.schema.alterTable('products', (t) => t.dropUnique(['store_id', 'sku'], 'products_store_sku_unique'));
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const [table, col] of [['product_stock', 'low_alerted'], ['stores', 'low_stock_threshold'], ['products', 'barcode']]) {
    await knex.raw(`alter table ${table} drop column ${col}`);
  }
}
