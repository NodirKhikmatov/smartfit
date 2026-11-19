// Task 52: transfers between the stores of one organisation. transfers = one move (draft → sent → received, or
// cancelled); transfer_items = its lines: the sending store's product, the same SKU's product in the receiving store,
// size, units sent, units received so far and the unit cost the units left with (task 49). transfer_scans = one row per
// receiving scan, keyed by the phone's own id (unique), so the offline queue applies each scan once.
// stock_movements gains the reason 'transfer' (out: delta < 0 in the sending store; in: delta > 0 in the receiving one,
// or back in the sending one on a cancel) and transfer_id. Postgres swaps the CHECK in place; SQLite rebuilds the table
// from its own CREATE text (nothing references stock_movements, so foreign keys can stay on).
import { REASONS } from './037_stock.js';

export const config = { transaction: false };

const isPg = (knex) => knex.client.config.client === 'pg';
const OLD = "'return', 'exchange')", NEW = "'return', 'exchange', 'transfer')";

async function swapReason(trx, from, to) {
  if (isPg(trx)) {
    const list = [...REASONS, ...(to === NEW ? ['transfer'] : [])].map((r) => `'${r}'`).join(', ');
    await trx.raw('alter table stock_movements drop constraint stock_movements_reason_check');
    return trx.raw(`alter table stock_movements add constraint stock_movements_reason_check check (reason in (${list}))`);
  }
  const rows = await trx.raw("select type, sql from sqlite_master where tbl_name = 'stock_movements' and sql is not null");
  const create = rows.find((r) => r.type === 'table').sql;
  if (!create.includes(from)) throw new Error('stock_movements: the reason CHECK is not the expected one');
  await trx.raw(create.replace(from, to).replace(/^CREATE TABLE [`"]?\w+[`"]?/, 'CREATE TABLE stock_movements_v2'));
  await trx.raw('insert into stock_movements_v2 select * from stock_movements');
  await trx.raw('drop table stock_movements');
  await trx.raw('alter table stock_movements_v2 rename to stock_movements');
  for (const r of rows.filter((x) => x.type === 'index')) await trx.raw(r.sql);
}

export async function up(knex) {
  await knex.transaction(async (trx) => {
    await trx.schema.createTable('transfers', (t) => {
      t.increments('id');
      t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
      t.integer('from_store_id').notNullable().references('stores.id').onDelete('CASCADE');
      t.integer('to_store_id').notNullable().references('stores.id').onDelete('CASCADE');
      t.string('status', 10).notNullable().defaultTo('draft');
      t.string('note', 200);
      // Admin ids are plain integers (no FK), like the other admin columns: admins are disabled, not deleted.
      for (const step of ['created', 'sent', 'received', 'cancelled']) {
        if (step !== 'created') t.timestamp(`${step}_at`, { useTz: true });
        t.integer(`${step}_by`);
        t.string(`${step}_email`, 200);
      }
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['from_store_id', 'status']);
      t.index(['to_store_id', 'status']);
      t.check("?? in ('draft', 'sent', 'received', 'cancelled')", ['status'], 'transfers_status_check');
      t.check('?? <> ??', ['from_store_id', 'to_store_id'], 'transfers_stores_check');
    });
    await trx.schema.createTable('transfer_items', (t) => {
      t.increments('id');
      t.integer('transfer_id').notNullable().references('transfers.id').onDelete('CASCADE');
      t.integer('product_id').notNullable().references('products.id').onDelete('CASCADE'); // the sending store's
      t.integer('to_product_id').notNullable().references('products.id').onDelete('CASCADE'); // same SKU, receiving store
      t.string('size', 20).notNullable();
      t.integer('quantity').notNullable();
      t.integer('received').notNullable().defaultTo(0);
      t.integer('unit_cost'); // set at sending: the sending product's cost then (null = not known)
      t.unique(['transfer_id', 'product_id', 'size']);
      t.check('?? > 0 and ?? >= 0 and ?? <= ??', ['quantity', 'received', 'received', 'quantity'], 'transfer_items_qty_check');
    });
    await trx.schema.createTable('transfer_scans', (t) => {
      t.increments('id');
      t.string('key', 40).notNullable().unique();
      t.integer('transfer_id').notNullable().references('transfers.id').onDelete('CASCADE');
      t.integer('item_id').notNullable().references('transfer_items.id').onDelete('CASCADE');
      t.integer('quantity').notNullable();
      t.integer('admin_id');
      t.string('admin_email', 200);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['transfer_id']);
    });
    await trx.schema.alterTable('stock_movements', (t) => t.integer('transfer_id'));
    await swapReason(trx, OLD, NEW);
  });
}

export async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx('stock_movements').where({ reason: 'transfer' }).del();
    await trx.raw('alter table stock_movements drop column transfer_id');
    await swapReason(trx, NEW, OLD);
    await trx.schema.dropTable('transfer_scans');
    await trx.schema.dropTable('transfer_items');
    await trx.schema.dropTable('transfers');
  });
}
