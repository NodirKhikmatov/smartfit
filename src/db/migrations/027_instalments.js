// Task 35: "Muddatli to'lov" at the cashier. The contract is made on the store's own Uzum/Alif Nasiya terminal; Smart
// Fit only shows the monthly amount and flags the order. stores.instalment_on + instalment_terms (JSON
// [{ months, percent }], kept while switched off). orders.instalment_* = the chosen term, the markup percent and the
// monthly amount as they were at checkout, so a later settings change never alters an old order. total is unchanged.
export async function up(knex) {
  await knex.schema.alterTable('stores', (t) => {
    t.boolean('instalment_on').notNullable().defaultTo(false);
    t.text('instalment_terms');
  });
  await knex.schema.alterTable('orders', (t) => {
    t.integer('instalment_months');
    t.integer('instalment_percent');
    t.integer('instalment_monthly');
  });
}

export async function down(knex) {
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const c of ['instalment_monthly', 'instalment_percent', 'instalment_months']) await knex.raw(`alter table orders drop column ${c}`);
  for (const c of ['instalment_terms', 'instalment_on']) await knex.raw(`alter table stores drop column ${c}`);
}
