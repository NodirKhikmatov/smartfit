// Task 28: the `staff` role (shop floor: one store, staff app only) and who took a fitting-room request and how fast.
// The role lives in two CHECKs (admins, admin_invites). Postgres swaps them in place; SQLite can't, so there each table is
// recreated from its own CREATE statement with the CHECK text replaced, rows copied, indexes put back (foreign keys off,
// like 012: a DROP TABLE with them on would null audit_log.admin_id and friends).
export const config = { transaction: false };

const isPg = (knex) => knex.client.config.client === 'pg';
// [table, constraint, old CHECK body, new CHECK body]. The SQLite text is exactly what 012 wrote.
const CHECKS = [
  ['admins', 'admins_role_check',
    "(role = 'super' and store_id is null and organization_id is null) or (role = 'owner' and organization_id is not null) or (role = 'manager' and store_id is not null and organization_id is not null)",
    "(role = 'super' and store_id is null and organization_id is null) or (role = 'owner' and organization_id is not null) or (role in ('manager','staff') and store_id is not null and organization_id is not null)"],
  ['admin_invites', 'admin_invites_role_check',
    "role in ('owner','manager') and (role = 'owner' or store_id is not null)",
    "role in ('owner','manager','staff') and (role = 'owner' or store_id is not null)"],
];

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

async function swapCheck(trx, [table, name, from, to]) {
  if (isPg(trx)) {
    await trx.raw(`alter table ${table} drop constraint ${name}`);
    return trx.raw(`alter table ${table} add constraint ${name} check (${to})`);
  }
  const rows = await trx.raw('select type, sql from sqlite_master where tbl_name = ? and sql is not null', [table]);
  const create = rows.find((r) => r.type === 'table').sql;
  if (!create.includes(from)) throw new Error(`${table}: ${name} is not the expected one`);
  await trx.raw(create.replace(from, to).replace(/^CREATE TABLE [`"]?\w+[`"]?/, `CREATE TABLE ${table}_v2`));
  await trx.raw(`insert into ${table}_v2 select * from ${table}`);
  await trx.raw(`drop table ${table}`);
  await trx.raw(`alter table ${table}_v2 rename to ${table}`);
  for (const r of rows.filter((x) => x.type === 'index')) await trx.raw(r.sql);
}

export async function up(knex) {
  await withFksOff(knex, async (trx) => {
    for (const c of CHECKS) await swapCheck(trx, c);
    // "Accepted" = still status 'new' with accepted_at set, so the status CHECK stays as it is. The admin ids have no
    // foreign key (SQLite can't DROP COLUMN one that has): admins are disabled, never deleted, except with their organisation.
    await trx.schema.alterTable('fitting_requests', (t) => {
      t.timestamp('accepted_at');
      t.integer('accepted_by');
      t.timestamp('done_at');
      t.integer('done_by');
    });
  });
}

export async function down(knex) {
  // Staff accounts can't exist before 018. Deleted with foreign keys on, so their audit rows keep the email and lose the link.
  await knex.transaction(async (trx) => {
    await trx('admin_invites').where({ role: 'staff' }).del();
    await trx('admins').where({ role: 'staff' }).del();
  });
  await withFksOff(knex, async (trx) => {
    for (const col of ['accepted_at', 'accepted_by', 'done_at', 'done_by']) await trx.raw(`alter table fitting_requests drop column ${col}`);
    for (const [table, name, from, to] of CHECKS) await swapCheck(trx, [table, name, to, from]);
  });
}
