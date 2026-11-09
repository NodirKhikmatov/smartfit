// Task 19: roles super/owner/manager, per-admin token_version (password change ends other sessions), disabled accounts,
// one-time invites, store hours and the audit log.

// Swaps the admins role CHECK and maps one role to another. Postgres alters the constraint in place; SQLite can't,
// so there the table is rebuilt (nothing references admins yet) and the email index is put back under its usual name.
async function setRoles(knex, roles, [from, to]) {
  const check = `(role = 'super' and store_id is null) or (role in (${roles.map((r) => `'${r}'`).join(',')}) and store_id is not null)`;
  if (knex.client.config.client === 'pg') {
    await knex.raw('alter table admins drop constraint admins_role_check');
    await knex('admins').where({ role: from }).update({ role: to });
    await knex.raw(`alter table admins add constraint admins_role_check check (${check})`);
    return;
  }
  await knex.schema.createTable('admins_v2', (t) => {
    t.increments('id');
    t.string('email').notNullable();
    t.string('password_hash').notNullable();
    t.string('role').notNullable();
    t.integer('store_id').references('stores.id').onDelete('CASCADE'); // null for super-admin
    t.timestamps(true, true);
    t.check(check, [], 'admins_role_check');
  });
  const cols = 'id, email, password_hash, store_id, created_at, updated_at';
  await knex.raw(`insert into admins_v2 (${cols}, role) select ${cols}, case when role = ? then ? else role end from admins`, [from, to]);
  await knex.schema.dropTable('admins');
  await knex.schema.renameTable('admins_v2', 'admins');
  await knex.schema.alterTable('admins', (t) => t.unique(['email'], { indexName: 'admins_email_unique' }));
}

export async function up(knex) {
  // Phase 1 had one CLI-made admin per store, who ran that store: they become its owner (same powers + settings and team).
  await setRoles(knex, ['owner', 'manager'], ['manager', 'owner']);
  await knex.schema.alterTable('admins', (t) => {
    t.integer('token_version').notNullable().defaultTo(0); // bumped on password change / disable: older tokens die
    t.timestamp('disabled_at');
  });
  await knex.schema.alterTable('stores', (t) => {
    t.string('opens_at', 5); // 'HH:MM', Tashkent time; null = not set
    t.string('closes_at', 5);
  });
  await knex.schema.createTable('admin_invites', (t) => {
    t.increments('id');
    t.string('token_hash', 64).notNullable().unique(); // sha256 of the link token; the token itself is never stored
    t.string('email').notNullable();
    t.string('role').notNullable();
    t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('created_by').references('admins.id').onDelete('SET NULL');
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.check("?? in ('owner','manager')", ['role'], 'admin_invites_role_check');
  });
  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.integer('admin_id').references('admins.id').onDelete('SET NULL');
    t.string('admin_email').notNullable(); // kept even if the admin row goes
    t.integer('store_id').references('stores.id').onDelete('CASCADE'); // null = not tied to a store (a super-admin's own account)
    t.string('action').notNullable();
    t.string('entity').notNullable();
    t.integer('entity_id');
    t.string('entity_label', 200); // product name, order number, email… as it was then
    t.json('before');
    t.json('after');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['store_id', 'id']);
    t.index(['entity', 'entity_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('admin_invites');
  // Native DROP COLUMN: knex's SQLite dropColumn rebuilds the table, and dropping `stores` inside the migration
  // transaction (foreign keys on) would cascade-delete its admins and products.
  for (const [table, col] of [['stores', 'closes_at'], ['stores', 'opens_at'], ['admins', 'disabled_at'], ['admins', 'token_version']]) {
    await knex.raw(`alter table ${table} drop column ${col}`);
  }
  await setRoles(knex, ['manager'], ['owner', 'manager']);
}
