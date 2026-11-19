// Task 54: account security. Two-step login (TOTP secret encrypted with a key derived from ADMIN_TOKEN_SECRET,
// the last used time step so a code works once), recovery codes and password reset links (sha256 only), the sign-in
// log behind "Kirishlar", and an organisation's "two-step login for everyone" rule.
// Sessions stay on admins.token_version (task 19): no sessions table, so every token signed before this deploy keeps working.
export async function up(knex) {
  await knex.schema.alterTable('admins', (t) => {
    t.string('totp_secret', 200); // "v1.<iv>.<tag>.<ciphertext>" (AES-256-GCM), null = two-step login off
    t.timestamp('totp_enabled_at');
    t.integer('totp_last_step'); // the 30 s step of the last accepted code: that code and older ones are refused
  });
  await knex.schema.alterTable('organizations', (t) => {
    t.boolean('require_two_step').notNullable().defaultTo(false);
  });
  await knex.schema.createTable('admin_recovery_codes', (t) => {
    t.increments('id');
    t.integer('admin_id').notNullable().references('admins.id').onDelete('CASCADE');
    t.string('code_hash', 64).notNullable(); // sha256 of an 80-bit code; the code is shown once
    t.timestamp('used_at');
    t.index(['admin_id', 'code_hash']);
  });
  await knex.schema.createTable('admin_resets', (t) => {
    t.increments('id');
    t.integer('admin_id').notNullable().references('admins.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique(); // sha256 of the link token, like admin_invites
    t.integer('created_by').references('admins.id').onDelete('SET NULL');
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('admin_logins', (t) => {
    t.increments('id');
    t.integer('admin_id').notNullable().references('admins.id').onDelete('CASCADE');
    t.enu('method', ['password', 'two_step', 'recovery', 'invite', 'reset']).notNullable();
    t.boolean('ok').notNullable();
    t.string('ip', 64);
    t.string('agent', 200);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['admin_id', 'id']);
  });
}

export async function down(knex) {
  for (const table of ['admin_logins', 'admin_resets', 'admin_recovery_codes']) await knex.schema.dropTable(table);
  await knex.raw('alter table organizations drop column require_two_step'); // native DROP COLUMN (see 009)
  for (const col of ['totp_last_step', 'totp_enabled_at', 'totp_secret']) await knex.raw(`alter table admins drop column ${col}`);
}
