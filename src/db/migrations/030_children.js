// Task 40: children's sizes. Two new category size kinds: 'kids' (by height, 92–164) and 'kids_shoes' (22–35).
// categories.audience and products.audience: 'adult' (the default, every existing row) or 'child'. A product copies its
// category's audience the way products.category copies its role, so the engine filters on one column. Boy / girl / any
// are the existing product genders male / female / unisex (no second system).
// A children's role product keeps its size list in products.sizes, like a role-less one (sizesOf reads it).
import { withFksOff } from './016_promos.js';

export const config = { transaction: false };

const isPg = (knex) => knex.client.config.client === 'pg';
const OLD_KINDS = "'clothes','shoes','one','custom'";
const NEW_KINDS = "'clothes','shoes','one','custom','kids','kids_shoes'";
const AUDIENCE = "varchar(10) not null default 'adult' check (audience in ('adult','child'))";

// SQLite can't change a CHECK in place: the same table SQL with the new list, rows copied, swapped, indexes put back.
async function setKinds(trx, from, to) {
  if (isPg(trx)) {
    await trx.raw('alter table categories drop constraint categories_size_kind_check');
    return trx.raw(`alter table categories add constraint categories_size_kind_check check (size_kind in (${to}))`);
  }
  const sql = (await trx.raw("select sql from sqlite_master where type = 'table' and name = 'categories'"))[0].sql;
  if (!sql.includes(`(${from})`)) throw new Error('categories is not the expected table');
  const indexes = (await trx.raw("select sql from sqlite_master where type = 'index' and tbl_name = 'categories' and sql is not null")).map((i) => i.sql);
  const v2 = sql.replace(`(${from})`, `(${to})`).replace(/^CREATE TABLE [`"]?categories[`"]? /, 'CREATE TABLE categories_v2 ');
  if (!v2.startsWith('CREATE TABLE categories_v2 ')) throw new Error('categories: unexpected table SQL');
  await trx.raw(v2);
  await trx.raw('insert into categories_v2 select * from categories');
  await trx.raw('drop table categories');
  await trx.raw('alter table categories_v2 rename to categories');
  for (const i of indexes) await trx.raw(i);
}

export const up = (knex) => withFksOff(knex, async (knex) => {
  await knex.raw(`alter table categories add column audience ${AUDIENCE}`);
  await knex.raw(`alter table products add column audience ${AUDIENCE}`);
  await setKinds(knex, OLD_KINDS, NEW_KINDS);
});

// Children's categories become role-less categories with their own size list (custom), so their products keep their
// sizes and stock rows (order lines point at them) and simply leave the outfits; the audience columns go.
export const down = (knex) => withFksOff(knex, async (knex) => {
  const kids = await knex('categories').whereIn('size_kind', ['kids', 'kids_shoes']).select('id', 'size_kind');
  for (const c of kids) {
    const sizes = c.size_kind === 'kids' ? '92,98,104,110,116,122,128,134,140,146,152,158,164' : Array.from({ length: 14 }, (_, i) => 22 + i).join(',');
    await knex('categories').where({ id: c.id }).update({ size_kind: 'custom', sizes, role: null });
    await knex('products').where({ category_id: c.id }).update({ category: null, sizes });
  }
  await setKinds(knex, NEW_KINDS, OLD_KINDS);
  // Native DROP COLUMN (see 009); the column's own CHECK goes with it.
  for (const t of ['products', 'categories']) await knex.raw(`alter table ${t} drop column audience`);
});
