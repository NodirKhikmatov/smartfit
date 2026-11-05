// Task 9: one row per Click/Payme transaction, so provider callbacks are idempotent.
// state follows Payme: 1 created/prepared, 2 paid, -1 cancelled before payment, -2 cancelled after payment (refund).

export async function up(knex) {
  await knex.schema.createTable('payment_transactions', (t) => {
    t.increments('id');
    t.string('provider').notNullable();
    t.string('ext_id').notNullable(); // the provider's transaction id
    t.integer('order_id').notNullable().references('orders.id');
    t.integer('amount').notNullable(); // so'm, always equal to the order total
    t.integer('state').notNullable();
    t.integer('reason');
    t.bigInteger('provider_time'); // Payme `time` param, ms
    t.bigInteger('create_time').notNullable(); // ms, as Payme reports them
    t.bigInteger('perform_time');
    t.bigInteger('cancel_time');
    t.unique(['provider', 'ext_id']);
    t.index(['order_id', 'state']);
    t.check("?? in ('click','payme')", ['provider'], 'payment_tx_provider_check');
    t.check('?? in (1, 2, -1, -2)', ['state'], 'payment_tx_state_check');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('payment_transactions');
}
