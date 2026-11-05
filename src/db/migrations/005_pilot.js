// Task 11: pilot funnel. One recommendation_logs row = one customer's results screen (−/+ re-queries update it).
// accepted = they put a suggested item in the cart, tried = they tapped "Kiyib ko'rdim", bought = a paid order
// whose cart came from that recommendation (orders.recommendation_id).

export async function up(knex) {
  await knex.schema.alterTable('recommendation_logs', (t) => {
    t.string('token', 32).unique(); // random, the customer app's only handle on its log row
    t.timestamp('accepted_at');
    t.timestamp('tried_at');
  });
  await knex.schema.alterTable('carts', (t) => t.integer('recommendation_id').references('recommendation_logs.id').onDelete('SET NULL'));
  await knex.schema.alterTable('orders', (t) => t.integer('recommendation_id').references('recommendation_logs.id').onDelete('SET NULL'));
}

export async function down(knex) {
  await knex.schema.alterTable('orders', (t) => t.dropForeign(['recommendation_id']).dropColumn('recommendation_id'));
  await knex.schema.alterTable('carts', (t) => t.dropForeign(['recommendation_id']).dropColumn('recommendation_id'));
  await knex.schema.alterTable('recommendation_logs', (t) => {
    t.dropUnique(['token']);
    t.dropColumn('tried_at');
    t.dropColumn('accepted_at');
    t.dropColumn('token');
  });
}
