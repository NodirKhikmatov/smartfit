// Task 24: missed demand (an item/size the recommender or the cart wanted, with 0 free stock), the customer funnel by
// step, and the owner's weekly Telegram report. No personal data in either log: no phone, name, photo or body numbers.
export async function up(knex) {
  await knex.schema.createTable('missed_demand', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE');
    t.string('size', 8).notNullable();
    t.string('session', 32).notNullable(); // the results screen's rec token (or the cart token): one count per customer
    t.string('source', 10).notNullable(); // recommend | cart
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['session', 'product_id', 'size']);
    t.index(['store_id', 'created_at']);
  });
  await knex.schema.createTable('funnel_events', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('visit', 32).notNullable(); // random per customer visit, made by the app
    t.string('step', 8).notNullable(); // start | size | outfits | cart | order
    t.string('device', 32); // the kiosk's heartbeat id; null = phone
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['visit', 'step']);
    t.index(['store_id', 'created_at']);
  });
  await knex.schema.alterTable('stores', (t) => {
    t.bigInteger('report_chat_id'); // owner's chat for the weekly report; null = not sent
    t.string('report_week', 10); // Monday (Tashkent, YYYY-MM-DD) of the last report sent
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('funnel_events');
  await knex.schema.dropTableIfExists('missed_demand');
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const col of ['report_chat_id', 'report_week']) await knex.raw(`alter table stores drop column ${col}`);
}
