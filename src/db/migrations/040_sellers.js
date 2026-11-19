// Task 50: who sold it. orders.seller_id = the team member the sale belongs to (set once, never overwritten; no FK,
// admins are disabled, not deleted), seller_at = when it was set (the report counts the sale then), seller_percent =
// the commission percent in force at that moment (a later settings change never rewrites an old order).
// stores.commission_percent = the store's percent (0 = off); admins.commission_percent = a personal one (null = the store's).
export async function up(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.integer('seller_id');
    t.timestamp('seller_at');
    t.integer('seller_percent');
    t.index(['seller_id']);
  });
  await knex.schema.alterTable('stores', (t) => t.integer('commission_percent').notNullable().defaultTo(0));
  await knex.schema.alterTable('admins', (t) => t.integer('commission_percent'));
}

export async function down(knex) {
  await knex.schema.alterTable('orders', (t) => t.dropIndex(['seller_id']));
  for (const col of ['seller_id', 'seller_at', 'seller_percent']) await knex.raw(`alter table orders drop column ${col}`);
  await knex.raw('alter table stores drop column commission_percent');
  await knex.raw('alter table admins drop column commission_percent');
}
