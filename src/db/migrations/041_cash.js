// Task 51: closing the day at the cashier. orders.paid_with = how the cashier took the money (cash | card | instalment;
// null for Click/Payme and for cashier orders paid before this task). orders.cancelled_at = when a paid order was
// cancelled (its whole total goes back then). cash_closings = one fixed report per store and Tashkent day: the numbers
// as they were at closing (report, JSON), the cash expected and counted, the difference and the manager's note.
export async function up(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.string('paid_with', 12);
    t.timestamp('cancelled_at');
  });
  await knex.schema.createTable('cash_closings', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.string('day', 10).notNullable(); // YYYY-MM-DD, Asia/Tashkent
    t.timestamp('closed_at').notNullable();
    t.integer('closed_by'); // no FK: admins are disabled, not deleted
    t.integer('expected_cash').notNullable();
    t.integer('counted_cash').notNullable();
    t.integer('difference').notNullable(); // counted − expected
    t.string('note', 500);
    t.text('report').notNullable();
    t.unique(['store_id', 'day']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('cash_closings');
  for (const col of ['paid_with', 'cancelled_at']) await knex.raw(`alter table orders drop column ${col}`);
}
