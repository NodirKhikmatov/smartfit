// Task 22: organisations (brand → stores), org-level owners and owner invites, and the landing page's demo requests.
// Existing stores and their owners/managers move into one default organisation, so nothing becomes unreachable.
// Owners now belong to an organisation and may have no store yet (they create it in the onboarding wizard), so the
// admins role CHECK changes and admin_invites.store_id becomes optional. SQLite can't alter either in place: both tables
// are rebuilt with foreign keys off (the documented 12-step way), because audit_log, sync_keys and admin_invites point at
// admins and a DROP TABLE with foreign keys on would null those links. PRAGMA foreign_keys is ignored inside a
// transaction, hence no knex transaction here; each half runs in its own.
export const config = { transaction: false };

const ADMIN_CHECK = {
  new: "(role = 'super' and store_id is null and organization_id is null) or (role = 'owner' and organization_id is not null) or (role = 'manager' and store_id is not null and organization_id is not null)",
  old: "(role = 'super' and store_id is null) or (role in ('owner','manager') and store_id is not null)",
};
const INVITE_CHECK = "role in ('owner','manager') and (role = 'owner' or store_id is not null)";
const isPg = (knex) => knex.client.config.client === 'pg';

async function withFksOff(knex, fn) {
  if (isPg(knex)) return knex.transaction(fn);
  await knex.raw('pragma foreign_keys = off');
  try {
    await knex.transaction(fn);
    const broken = await knex.raw('pragma foreign_key_check');
    if (broken.length) throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
  } finally {
    await knex.raw('pragma foreign_keys = on');
  }
}

// SQLite only: new admins / admin_invites tables with the given shape, rows copied by `select`, then swapped in.
async function rebuildAdmins(trx, withOrg, select) {
  await trx.schema.createTable('admins_v2', (t) => {
    t.increments('id');
    t.string('email').notNullable();
    t.string('password_hash').notNullable();
    t.string('role').notNullable();
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    if (withOrg) t.integer('organization_id').references('organizations.id').onDelete('CASCADE');
    t.timestamps(true, true);
    t.integer('token_version').notNullable().defaultTo(0);
    t.timestamp('disabled_at');
    t.check(withOrg ? ADMIN_CHECK.new : ADMIN_CHECK.old, [], 'admins_role_check');
  });
  await trx.raw(`insert into admins_v2 ${select}`);
  await trx.schema.dropTable('admins');
  await trx.schema.renameTable('admins_v2', 'admins');
  await trx.schema.alterTable('admins', (t) => t.unique(['email'], { indexName: 'admins_email_unique' }));
}
async function rebuildInvites(trx, withOrg, select) {
  await trx.schema.createTable('admin_invites_v2', (t) => {
    t.increments('id');
    t.string('token_hash', 64).notNullable(); // unique index added after the swap, under its usual name
    t.string('email').notNullable();
    t.string('role').notNullable();
    if (withOrg) {
      t.integer('store_id').references('stores.id').onDelete('CASCADE'); // null = owner invite (store made in the wizard)
      t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    } else t.integer('store_id').notNullable().references('stores.id').onDelete('CASCADE');
    t.integer('created_by').references('admins.id').onDelete('SET NULL');
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamp('created_at').notNullable().defaultTo(trx.fn.now());
    t.check(withOrg ? INVITE_CHECK : "?? in ('owner','manager')", withOrg ? [] : ['role'], 'admin_invites_role_check');
  });
  await trx.raw(`insert into admin_invites_v2 ${select}`);
  await trx.schema.dropTable('admin_invites');
  await trx.schema.renameTable('admin_invites_v2', 'admin_invites');
  await trx.schema.alterTable('admin_invites', (t) => t.unique(['token_hash'], { indexName: 'admin_invites_token_hash_unique' }));
}

const ADMIN_COLS = 'id, email, password_hash, role, store_id, created_at, updated_at, token_version, disabled_at';
const INVITE_COLS = 'id, token_hash, email, role, store_id, created_by, expires_at, used_at, created_at';

export async function up(knex) {
  await withFksOff(knex, async (trx) => {
    await trx.schema.createTable('organizations', (t) => {
      t.increments('id');
      t.string('name', 120).notNullable();
      t.timestamps(true, true);
    });
    await trx.raw('alter table stores add column organization_id integer references organizations(id) on delete cascade');
    await trx.raw('create index stores_organization_id_index on stores (organization_id)');
    // One default organisation for whatever exists (a fresh database gets none; the seed and onboarding make them).
    const has = (await trx('stores').first('id')) || (await trx('admins').whereNot('role', 'super').first('id'));
    const orgId = has ? (await trx('organizations').insert({ name: 'Smart Fit' }).returning('id'))[0].id : null;
    await trx('stores').update({ organization_id: orgId });

    if (isPg(trx)) {
      await trx.raw('alter table admins drop constraint admins_role_check');
      await trx.raw('alter table admins add column organization_id integer references organizations(id) on delete cascade');
      await trx('admins').whereNot('role', 'super').update({ organization_id: orgId });
      await trx.raw(`alter table admins add constraint admins_role_check check (${ADMIN_CHECK.new})`);
      await trx.raw('alter table admin_invites drop constraint admin_invites_role_check');
      await trx.raw('alter table admin_invites alter column store_id drop not null');
      await trx.raw('alter table admin_invites add column organization_id integer references organizations(id) on delete cascade');
      await trx('admin_invites').update({ organization_id: orgId });
      await trx.raw('alter table admin_invites alter column organization_id set not null');
      await trx.raw(`alter table admin_invites add constraint admin_invites_role_check check (${INVITE_CHECK})`);
    } else {
      await rebuildAdmins(trx, true, `(${ADMIN_COLS}, organization_id) select ${ADMIN_COLS}, case when role = 'super' then null else ${orgId ?? 'null'} end from admins`);
      await rebuildInvites(trx, true, `(${INVITE_COLS}, organization_id) select ${INVITE_COLS}, ${orgId ?? 'null'} from admin_invites`);
    }
    await trx.raw('create index admins_organization_id_index on admins (organization_id)');

    // "Demo so'rash" form on the landing page. notified_at: sent to the product owner's Telegram (outbox, like orders).
    await trx.schema.createTable('demo_requests', (t) => {
      t.increments('id');
      t.string('name', 80).notNullable();
      t.string('phone', 20).notNullable();
      t.string('company', 120).notNullable();
      t.string('city', 80);
      t.integer('stores');
      t.string('message', 500);
      t.string('lang', 2).notNullable();
      t.timestamp('created_at').notNullable().defaultTo(trx.fn.now());
      t.timestamp('notified_at');
      t.timestamp('handled_at');
    });
  });
}

// Owners without a store and owner invites without one can't exist before 012: they are removed.
export async function down(knex) {
  await withFksOff(knex, async (trx) => {
    await trx.schema.dropTableIfExists('demo_requests');
    await trx('admins').where({ role: 'owner' }).whereNull('store_id').del();
    await trx('admin_invites').whereNull('store_id').del();
    await trx.raw('drop index if exists admins_organization_id_index');
    if (isPg(trx)) {
      await trx.raw('alter table admins drop constraint admins_role_check');
      await trx.raw('alter table admins drop column organization_id');
      await trx.raw(`alter table admins add constraint admins_role_check check (${ADMIN_CHECK.old})`);
      await trx.raw('alter table admin_invites drop constraint admin_invites_role_check');
      await trx.raw('alter table admin_invites drop column organization_id');
      await trx.raw('alter table admin_invites alter column store_id set not null');
      await trx.raw("alter table admin_invites add constraint admin_invites_role_check check (role in ('owner','manager'))");
    } else {
      await rebuildAdmins(trx, false, `(${ADMIN_COLS}) select ${ADMIN_COLS} from admins`);
      await rebuildInvites(trx, false, `(${INVITE_COLS}) select ${INVITE_COLS} from admin_invites`);
    }
    await trx.raw('drop index if exists stores_organization_id_index');
    await trx.raw('alter table stores drop column organization_id');
    await trx.schema.dropTable('organizations');
  });
}
