// Task 27: customer profile verified through the Telegram bot (shared contact = phone check, no SMS).
// One profile per Telegram user per organisation. Only numbers and sizes about the body; never a photo.
// profile_tokens: the one-time deep links ("save my profile") and kiosk login QRs, short-lived and random.
export async function up(knex) {
  await knex.schema.createTable('customer_profiles', (t) => {
    t.increments('id');
    t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    t.bigInteger('telegram_user_id').notNullable();
    t.string('phone', 16).notNullable(); // +digits, from the contact Telegram verified (same form as orders.phone)
    t.string('name', 120);
    t.string('lang', 2).notNullable().defaultTo('uz');
    t.string('gender');
    t.integer('height');
    t.integer('weight');
    t.string('shoes', 3);
    t.string('top', 3);
    t.string('bottom', 3);
    t.integer('shoulder'); // cm, the size step's estimate
    t.integer('hip'); // cm
    t.string('access_hash', 64).unique(); // sha256 of the profile page link token (sent in the bot chat)
    t.timestamp('access_expires_at');
    t.timestamp('consent_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['organization_id', 'telegram_user_id']);
    t.index(['organization_id', 'phone']);
  });
  await knex.schema.createTable('customer_looks', (t) => {
    t.increments('id');
    t.integer('profile_id').notNullable().references('customer_profiles.id').onDelete('CASCADE');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.text('items').notNullable(); // JSON array of product ids, sorted
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('profile_tokens', (t) => {
    t.increments('id');
    t.string('token', 32).notNullable().unique(); // in the t.me link / QR
    t.string('poll', 32).notNullable().unique(); // only the screen that asked knows it: a photo of the QR can't read the result
    t.string('kind').notNullable(); // save | login
    t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.string('lang', 2).notNullable();
    t.text('data'); // save: the numbers and looks to keep (JSON); login: null
    t.string('state').notNullable().defaultTo('new'); // new → opened (bot /start) → done | missing
    t.bigInteger('telegram_user_id'); // who opened it; only their own contact can finish it
    t.integer('profile_id').references('customer_profiles.id').onDelete('CASCADE');
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['telegram_user_id', 'state']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('profile_tokens');
  await knex.schema.dropTable('customer_looks');
  await knex.schema.dropTable('customer_profiles');
}
