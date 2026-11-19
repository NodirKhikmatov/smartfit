// Task 53: mall analytics. mall_stats holds counters only: one row per mall, Tashkent day and hour, kind, channel,
// shop and search word, with a count n. There is no visitor, device, IP, phone, profile, photo or free text column;
// the only customer text is the normalised search word (≤ 40 characters, never tied to anything but the hour).
// store_id 0 / word '' stand for "none" so the unique key also works for those rows (NULLs never conflict).
// malls.report_chat_id / report_week: the weekly digest in Telegram, like stores' (task 24).
export const MALL_EVENTS = ['visit', 'search', 'nothing', 'shop', 'pin']; // nothing = a search that found nothing in any shop
export async function up(knex) {
  await knex.schema.createTable('mall_stats', (t) => {
    t.increments('id');
    t.integer('mall_id').notNullable(); // no foreign key, like the other mall ids (024)
    t.string('day', 10).notNullable(); // YYYY-MM-DD, Asia/Tashkent
    t.integer('hour').notNullable(); // 0–23, Asia/Tashkent
    t.enu('kind', MALL_EVENTS).notNullable();
    t.enu('channel', ['kiosk', 'phone']).notNullable();
    t.integer('store_id').notNullable().defaultTo(0);
    t.string('word', 40).notNullable().defaultTo('');
    t.integer('n').notNullable().defaultTo(0);
    t.unique(['mall_id', 'day', 'hour', 'kind', 'channel', 'store_id', 'word'], { indexName: 'mall_stats_key' });
  });
  await knex.schema.alterTable('malls', (t) => {
    t.bigInteger('report_chat_id');
    t.string('report_week', 10);
  });
}

export async function down(knex) {
  for (const col of ['report_chat_id', 'report_week']) await knex.raw(`alter table malls drop column ${col}`); // native DROP COLUMN (see 009)
  await knex.schema.dropTable('mall_stats');
}
