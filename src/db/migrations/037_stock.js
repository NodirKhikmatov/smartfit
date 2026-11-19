// Task 47: stock movements, receiving and counts.
// stock_movements: every change of product_stock.quantity, whoever made it (who, when, why, before and after).
// stock_sessions: a receiving (scans add stock at once) or a count (scans are only recorded; a manager confirms the
// differences). stock_scans: one row per scan the phone sent. Sessions and scans carry the phone's own id (`key`,
// unique), so a replayed request (the offline queue, a double tap, a retry) is applied once.
// Admin ids are plain integers (no FK), like the other admin columns: admins are disabled, not deleted.
export const REASONS = ['admin', 'csv', 'sync', 'receive', 'count', 'sale', 'cancel', 'return', 'exchange'];

export async function up(knex) {
  await knex.schema.createTable('stock_sessions', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('kind', 10).notNullable();
    t.string('status', 10).notNullable().defaultTo('open');
    t.string('note', 200);
    t.integer('category_id'); // a count's scope: a category and/or a shelf
    t.string('shelf', 40);
    t.integer('created_by');
    t.string('created_email', 200);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('closed_at', { useTz: true });
    t.integer('closed_by');
    t.index(['store_id', 'status']);
    t.check("?? in ('receive', 'count')", ['kind'], 'stock_sessions_kind_check');
    t.check("?? in ('open', 'closed', 'confirmed', 'cancelled')", ['status'], 'stock_sessions_status_check');
  });
  await knex.schema.createTable('stock_scans', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.integer('session_id').notNullable().references('stock_sessions.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.string('size', 20).notNullable();
    t.integer('quantity').notNullable();
    t.integer('admin_id');
    t.string('admin_email', 200);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['session_id']);
  });
  await knex.schema.createTable('stock_movements', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.string('size', 20).notNullable();
    t.integer('delta').notNullable();
    t.integer('quantity_before').notNullable();
    t.integer('quantity_after').notNullable();
    t.string('reason', 10).notNullable();
    t.integer('admin_id');
    t.string('admin_email', 200); // "API: <key name>" for the sync API, null for a customer's payment
    t.integer('session_id');
    t.integer('order_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['product_id', 'id']);
    t.index(['store_id', 'created_at']);
    t.check(`?? in (${REASONS.map((r) => `'${r}'`).join(', ')})`, ['reason'], 'stock_movements_reason_check');
  });
}

export async function down(knex) {
  await knex.schema.dropTable('stock_movements');
  await knex.schema.dropTable('stock_scans');
  await knex.schema.dropTable('stock_sessions');
}
