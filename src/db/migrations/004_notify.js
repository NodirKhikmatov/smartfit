// Task 10: customer notifications. The customer links Telegram with /start <notify_token>;
// `notified` is the last order stage they were told about, so the notifier sends only what changed.

export async function up(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.string('notify_token', 32).unique(); // random, shown only on the customer's order screen
    t.bigInteger('telegram_chat_id');
    t.string('notified');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.dropUnique(['notify_token']);
    t.dropColumn('notified');
    t.dropColumn('telegram_chat_id');
    t.dropColumn('notify_token');
  });
}
