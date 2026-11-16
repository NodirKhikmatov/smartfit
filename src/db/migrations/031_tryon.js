// Task 41: AI try-on. stores.tryon_on (the shop's switch, off by default) and tryon_daily_limit (pictures per Tashkent
// day, because each one is paid). tryon_usage keeps one count per store and day, nothing about the customer or the picture.
export async function up(knex) {
  await knex.schema.alterTable('stores', (t) => {
    t.boolean('tryon_on').notNullable().defaultTo(false);
    t.integer('tryon_daily_limit').notNullable().defaultTo(30);
  });
  await knex.schema.createTable('tryon_usage', (t) => {
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('day', 10).notNullable(); // YYYY-MM-DD, Asia/Tashkent
    t.integer('count').notNullable().defaultTo(0);
    t.primary(['store_id', 'day']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('tryon_usage');
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const c of ['tryon_daily_limit', 'tryon_on']) await knex.raw(`alter table stores drop column ${c}`);
}
