// Task 33: where the customer will wear it (daily | work | party | sport | travel) on the results screen log, so the
// Talab page shows demand per occasion. null = not chosen (or an older log). No personal data.
export async function up(knex) {
  await knex.schema.alterTable('recommendation_logs', (t) => t.string('occasion', 8));
}

export async function down(knex) {
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('alter table recommendation_logs drop column occasion');
}
