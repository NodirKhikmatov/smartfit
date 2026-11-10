// Task 32: QR labels on garments. One row per label scan: store, product, time and a random token the item page uses
// for the fitting-room request. No IP, device or anything about the customer.
export async function up(knex) {
  await knex.schema.createTable('qr_scans', (t) => {
    t.increments('id');
    t.string('token', 32).notNullable().unique();
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['store_id', 'created_at']);
  });
  // A fitting-room request from a label's item page has no results screen behind it, only the scan. No foreign key:
  // SQLite can't DROP COLUMN one that has (see 018); the id is only used to cap open requests per scan.
  await knex.schema.alterTable('fitting_requests', (t) => t.integer('scan_id'));
}

export async function down(knex) {
  await knex.schema.alterTable('fitting_requests', (t) => t.dropColumn('scan_id'));
  await knex.schema.dropTable('qr_scans');
}
