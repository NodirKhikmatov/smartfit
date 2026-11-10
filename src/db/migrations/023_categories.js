// Task 36: each organisation's own categories. A category has a name in Uzbek and Russian, an optional photo, a sort
// order, a hidden switch, an optional outfit role (the five values the engine works on) and a size kind. Products point
// at their category (category_id); products.category keeps the role, copied from the category (null = no role: never in
// an outfit), so the engine and every query on it stay as they are. products.sizes holds the size list of a role-less
// product (its category's), null for role products (sizes by role, as before).
// products.category was NOT NULL: Postgres drops that in place; SQLite can't, so the table is recreated from its own
// CREATE statement without it (foreign keys off, like 018: a DROP TABLE with them on would cascade to the stock rows).
import { DICT } from '../../../public/shared/i18n.js';

export const config = { transaction: false };

const isPg = (knex) => knex.client.config.client === 'pg';
export const ROLES = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
export const SIZE_KINDS = ['clothes', 'shoes', 'one', 'custom'];
export const ROLE_KIND = { outerwear: 'clothes', top: 'clothes', bottom: 'clothes', shoes: 'shoes', accessory: 'one' };
// Every organisation starts with these (the five fixed categories before task 36); it can rename, hide or add to them.
// Names are the dictionary's cat.<role> texts ("Ustki kiyim" / "Верхняя одежда" …).
export const BUILTIN = ROLES.map((role) => ({ role, name: DICT.uz[`cat.${role}`], name_ru: DICT.ru[`cat.${role}`] }));
export const builtinRows = (organization_id) => BUILTIN.map((c, i) => ({ ...c, organization_id, sort: i + 1, size_kind: ROLE_KIND[c.role] }));

const NOT_NULL = '`category` varchar(255) not null';
const NULLABLE = '`category` varchar(255)';

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

// products.category NOT NULL on or off. SQLite: recreate from its own CREATE text (the 018 way), indexes put back.
async function categoryNullable(trx, nullable) {
  if (isPg(trx)) return trx.raw(`alter table products alter column category ${nullable ? 'drop' : 'set'} not null`);
  const rows = await trx.raw("select type, sql from sqlite_master where tbl_name = 'products' and sql is not null");
  const create = rows.find((r) => r.type === 'table').sql;
  const [from, to] = nullable ? [NOT_NULL, NULLABLE] : [NULLABLE, NOT_NULL];
  if (!create.includes(`${from},`)) throw new Error('products: category column is not the expected one');
  await trx.raw(create.replace(`${from},`, `${to},`).replace(/^CREATE TABLE [`"]?\w+[`"]?/, 'CREATE TABLE products_v2'));
  await trx.raw('insert into products_v2 select * from products');
  await trx.raw('drop table products');
  await trx.raw('alter table products_v2 rename to products');
  for (const r of rows.filter((x) => x.type === 'index')) await trx.raw(r.sql);
}

export async function up(knex) {
  await withFksOff(knex, async (trx) => {
    await trx.schema.createTable('categories', (t) => {
      t.increments('id');
      t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
      t.string('name', 60).notNullable();
      t.string('name_ru', 60).notNullable();
      t.string('image_url');
      t.integer('sort').notNullable().defaultTo(0);
      t.boolean('hidden').notNullable().defaultTo(false);
      t.string('role', 20); // null = not part of an outfit
      t.string('size_kind', 10).notNullable();
      t.string('sizes', 400); // the shop's own list (size_kind 'custom'), comma-separated
      t.timestamps(true, true);
      t.index(['organization_id', 'sort']);
      t.check(`?? is null or ?? in (${ROLES.map((r) => `'${r}'`).join(',')})`, ['role', 'role'], 'categories_role_check');
      t.check(`?? in (${SIZE_KINDS.map((r) => `'${r}'`).join(',')})`, ['size_kind'], 'categories_size_kind_check');
    });
    for (const { id } of await trx('organizations').select('id')) await trx('categories').insert(builtinRows(id));

    // No foreign key on category_id: SQLite can't DROP COLUMN one that has (see 018). The app keeps it within the
    // organisation and refuses to delete a category that still has products.
    await trx.schema.alterTable('products', (t) => {
      t.integer('category_id');
      t.string('sizes', 400);
      t.string('description_ru', 300);
      t.text('details'); // JSON [{ name, value }], at most 10
    });
    await trx.raw(`update products set category_id = (select c.id from categories c join stores s on s.organization_id = c.organization_id
      where s.id = products.store_id and c.role = products.category order by c.sort, c.id limit 1)`);
    await categoryNullable(trx, true);
    await trx.raw('create index products_category_id_index on products (category_id)');
  });
}

// Role-less products can't exist before 023. They become accessories (the old catch-all) and keep their stock rows,
// rather than being deleted (order lines point at them without a cascade).
export async function down(knex) {
  await withFksOff(knex, async (trx) => {
    await trx('products').whereNull('category').update({ category: 'accessory' });
    await trx.raw('drop index if exists products_category_id_index');
    for (const col of ['details', 'description_ru', 'sizes', 'category_id']) await trx.raw(`alter table products drop column ${col}`);
    await categoryNullable(trx, false);
    await trx.schema.dropTable('categories');
  });
}
