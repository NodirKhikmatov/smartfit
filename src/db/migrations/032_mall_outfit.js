// Task 42: an outfit from the whole mall. One mall_recs row per mall results screen (the mall admin's count; nothing of
// the customer or any shop), and each shop that had items on that screen gets its own recommendation_logs row with
// only its own items, tied to the screen by mall_rec_id (no foreign key, like 024: the app keeps it right).
export async function up(knex) {
  await knex.schema.createTable('mall_recs', (t) => {
    t.increments('id');
    t.integer('mall_id').notNullable();
    t.string('token', 32).notNullable().unique();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['mall_id', 'created_at']);
  });
  await knex.schema.alterTable('recommendation_logs', (t) => {
    t.integer('mall_rec_id').nullable().index();
  });
}

export async function down(knex) {
  await knex.raw('drop index if exists recommendation_logs_mall_rec_id_index');
  await knex.raw('alter table recommendation_logs drop column mall_rec_id'); // native DROP COLUMN (see 009)
  await knex.schema.dropTable('mall_recs');
}
