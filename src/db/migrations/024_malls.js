// Task 37: shopping malls. A mall holds shops (stores of different organisations); a store may sit in one mall, with its
// floor, unit, logo and whether the mall's directory shows it. New `mall` admin role (one mall, summary numbers only).
// organizations.mall_id = the mall that invited the shop: its first store joins that mall.
// No foreign keys on the new id columns (SQLite can't DROP COLUMN one); the app keeps them right (like 018/023).
// The role lives in the admins / admin_invites CHECKs again, and a mall invite has no organisation, so
// admin_invites.organization_id drops NOT NULL. Same way as 018: Postgres in place, SQLite recreates each table from its
// own CREATE text with the parts replaced (foreign keys off).
export const config = { transaction: false };

const isPg = (knex) => knex.client.config.client === 'pg';
const ADMIN_OLD = "(role = 'super' and store_id is null and organization_id is null) or (role = 'owner' and organization_id is not null) or (role in ('manager','staff') and store_id is not null and organization_id is not null)";
const INVITE_OLD = "role in ('owner','manager','staff') and (role = 'owner' or store_id is not null)";
// [table, constraint, [old text, new text] pairs]; the CHECK texts are exactly what 018 wrote.
const SWAPS = [
  ['admins', 'admins_role_check', [[ADMIN_OLD, `${ADMIN_OLD} or (role = 'mall' and mall_id is not null and store_id is null and organization_id is null)`]]],
  ['admin_invites', 'admin_invites_role_check', [
    [INVITE_OLD, `(${INVITE_OLD} and organization_id is not null) or (role = 'mall' and mall_id is not null and store_id is null and organization_id is null)`],
    ['`organization_id` integer not null', '`organization_id` integer'],
  ]],
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

async function swap(trx, [table, name, pairs], back) {
  const parts = pairs.map(([a, b]) => (back ? [b, a] : [a, b]));
  if (isPg(trx)) {
    await trx.raw(`alter table ${table} drop constraint ${name}`);
    if (table === 'admin_invites') await trx.raw(`alter table admin_invites alter column organization_id ${back ? 'set' : 'drop'} not null`);
    return trx.raw(`alter table ${table} add constraint ${name} check (${parts[0][1]})`);
  }
  const rows = await trx.raw('select type, sql from sqlite_master where tbl_name = ? and sql is not null', [table]);
  let create = rows.find((r) => r.type === 'table').sql;
  for (const [from, to] of parts) {
    if (!create.includes(from)) throw new Error(`${table}: ${name} is not the expected one`);
    create = create.replace(from, to);
  }
  await trx.raw(create.replace(/^CREATE TABLE [`"]?\w+[`"]?/, `CREATE TABLE ${table}_v2`));
  await trx.raw(`insert into ${table}_v2 select * from ${table}`);
  await trx.raw(`drop table ${table}`);
  await trx.raw(`alter table ${table}_v2 rename to ${table}`);
  for (const r of rows.filter((x) => x.type === 'index')) await trx.raw(r.sql);
}

export async function up(knex) {
  await knex.schema.createTable('malls', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('city', 80).notNullable();
    t.string('address', 200).notNullable();
    t.float('lat'); // optional map point, both or neither
    t.float('lon');
    t.string('logo_url');
    t.timestamps(true, true);
  });
  await knex.schema.alterTable('stores', (t) => {
    t.integer('mall_id');
    t.string('mall_floor', 20);
    t.string('mall_unit', 20);
    t.boolean('mall_hidden').notNullable().defaultTo(false); // hidden from the mall's directory and search
    t.string('logo_url');
  });
  await knex.schema.alterTable('organizations', (t) => t.integer('mall_id'));
  await withFksOff(knex, async (trx) => {
    for (const table of ['admins', 'admin_invites']) await trx.schema.alterTable(table, (t) => t.integer('mall_id'));
    for (const s of SWAPS) await swap(trx, s, false);
  });
}

export async function down(knex) {
  // Mall admins can't exist before 024. Deleted with foreign keys on, so their audit rows keep the email and lose the link.
  await knex.transaction(async (trx) => {
    await trx('admin_invites').where({ role: 'mall' }).del();
    await trx('admins').where({ role: 'mall' }).del();
  });
  await withFksOff(knex, async (trx) => {
    for (const s of SWAPS) await swap(trx, s, true);
    for (const table of ['admins', 'admin_invites', 'organizations']) await trx.raw(`alter table ${table} drop column mall_id`);
    for (const col of ['mall_id', 'mall_floor', 'mall_unit', 'mall_hidden', 'logo_url']) await trx.raw(`alter table stores drop column ${col}`);
  });
  await knex.schema.dropTable('malls');
}
