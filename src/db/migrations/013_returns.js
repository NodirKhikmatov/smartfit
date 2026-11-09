// Task 23: returns and size exchanges on order lines, the customer's "how did it fit?" answer per line, and the owner's
// per-product fit offset override (null = learnt from answers and size returns).
export async function up(knex) {
  await knex.schema.createTable('order_returns', (t) => {
    t.increments('id');
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('order_item_id').notNullable().references('order_items.id').onDelete('CASCADE');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('kind', 10).notNullable(); // return | exchange (same product, another size)
    t.string('reason', 12).notNullable(); // too_small | too_big | disliked | defect
    t.integer('quantity').notNullable();
    t.integer('refund').notNullable().defaultTo(0); // so'm; never more than quantity × the line's unit price
    t.boolean('restock').notNullable();
    t.string('new_size', 8); // exchange only
    t.string('request_key', 32).unique(); // the admin dialog's one-time key: a double submit finds the first row
    t.integer('admin_id').references('admins.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['store_id', 'created_at']);
    t.check("?? > 0 and ?? >= 0 and ?? in ('return','exchange') and ?? in ('too_small','too_big','disliked','defect')", ['quantity', 'refund', 'kind', 'reason'], 'order_returns_check');
  });
  await knex.schema.alterTable('order_items', (t) => {
    t.integer('returned').notNullable().defaultTo(0); // units returned or exchanged; a conditional UPDATE keeps it ≤ quantity
    t.string('fit', 6); // small | right | big, from the status page
    t.timestamp('fit_at');
  });
  await knex.schema.alterTable('products', (t) => {
    t.integer('fit_offset'); // owner override: -1 runs big, 0 true to size, +1 runs small; null = automatic
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('order_returns');
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const [table, col] of [['order_items', 'returned'], ['order_items', 'fit'], ['order_items', 'fit_at'], ['products', 'fit_offset']]) {
    await knex.raw(`alter table ${table} drop column ${col}`);
  }
}
