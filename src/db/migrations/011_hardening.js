// Task 21: open-cart cap per client, the kiosk staff exit PIN (hashed) and the kiosk heartbeat.
export async function up(knex) {
  await knex.schema.alterTable('carts', (t) => {
    t.string('client', 16).index(); // sha256(ip) prefix: counts open carts per client; gone with the cart
  });
  await knex.schema.alterTable('stores', (t) => {
    t.string('kiosk_pin_hash', 200); // scrypt, like admin passwords; null = no PIN set
  });
  await knex.schema.createTable('kiosks', (t) => {
    t.increments('id');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('device', 32).notNullable(); // random id the kiosk keeps in localStorage
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at').notNullable();
    t.unique(['store_id', 'device']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('kiosks');
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('drop index if exists carts_client_index');
  for (const [table, col] of [['stores', 'kiosk_pin_hash'], ['carts', 'client']]) await knex.raw(`alter table ${table} drop column ${col}`);
}
