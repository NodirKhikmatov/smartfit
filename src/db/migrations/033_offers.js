// Task 43: shop offers (aksiyalar). A shop writes an offer for one of its stores; inside a mall the mall admin approves
// or rejects it before it shows on the mall screen and the mall kiosk's idle slides. offer_stats keeps counts only
// (shown / tapped per offer and Tashkent day), nothing about who saw or tapped. malls.slide_seconds = idle slide time.
// No foreign keys on organization_id / store_id / mall_id / promo_code_id / product_id (like 024: SQLite can't drop
// such a column in down; the app keeps them right).
export async function up(knex) {
  await knex.schema.createTable('offers', (t) => {
    t.increments('id');
    t.integer('organization_id').notNullable();
    t.integer('store_id').notNullable().index();
    t.integer('mall_id').nullable(); // the mall it was submitted to (null = a shop outside any mall: no approval step)
    t.string('title', 60).notNullable();
    t.string('title_ru', 60).notNullable();
    t.string('body', 160);
    t.string('body_ru', 160);
    t.string('image_url');
    t.timestamp('starts_at').notNullable(); // ISO strings like promo_codes: start of the first Tashkent day
    t.timestamp('ends_at').notNullable(); // start of the day after the last one (exclusive)
    t.integer('promo_code_id');
    t.integer('product_id');
    t.enu('status', ['draft', 'submitted', 'approved', 'rejected']).notNullable().defaultTo('draft');
    t.string('reject_reason', 200);
    t.integer('sort').notNullable().defaultTo(0); // the mall admin's slide order
    t.timestamp('reviewed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['mall_id', 'status']);
  });
  await knex.schema.createTable('offer_stats', (t) => {
    t.integer('offer_id').notNullable();
    t.string('day', 10).notNullable(); // YYYY-MM-DD, Asia/Tashkent
    t.integer('shown').notNullable().defaultTo(0);
    t.integer('tapped').notNullable().defaultTo(0);
    t.primary(['offer_id', 'day']);
  });
  await knex.schema.alterTable('malls', (t) => {
    t.integer('slide_seconds').notNullable().defaultTo(8);
  });
}

export async function down(knex) {
  await knex.raw('alter table malls drop column slide_seconds'); // native DROP COLUMN (see 009)
  await knex.schema.dropTable('offer_stats');
  await knex.schema.dropTable('offers');
}
