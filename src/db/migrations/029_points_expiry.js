// Task 39: points expiry and a manual correction, both as points_ledger rows so the balance stays the sum of the rows.
// points_ledger: kind adds 'expire' (written by the sweep, ref 'expire:<newest expired lot row id>') and 'adjust'
// (an owner's correction, ref 'adjust:<random>'); neither belongs to an order, so order_id becomes nullable;
// admin_id (no FK, like audit_log) and note (the required reason) for a correction.
// organizations: points_expiry_months (0 = off, the default; 1–36) and points_expiry_since (when it was turned on:
// older points count from that moment, so turning expiry on never wipes old points at once).
// customer_profiles.points_reminded_lot: the newest lot row the last expiry reminder covered (one message per batch).
import { withFksOff } from './016_promos.js';

export const config = { transaction: false };

const OLD_KINDS = "'earn','spend','refund','clawback','return'";
const NEW_KINDS = "'earn','spend','refund','clawback','return','expire','adjust'";
const isPg = (knex) => knex.client.config.client === 'pg';

// SQLite can't change NOT NULL or a CHECK in place: the same table SQL with the edits, rows copied, swapped, indexes back.
async function rebuildLedger(trx, edits) {
  let sql = (await trx.raw("select sql from sqlite_master where type = 'table' and name = 'points_ledger'"))[0].sql;
  for (const [from, to] of edits) {
    if (!sql.includes(from)) throw new Error(`points_ledger is not the expected table (${from})`);
    sql = sql.replace(from, to);
  }
  const indexes = (await trx.raw("select sql from sqlite_master where type = 'index' and tbl_name = 'points_ledger' and sql is not null")).map((i) => i.sql);
  const v2 = sql.replace(/^CREATE TABLE [`"]?points_ledger[`"]? /, 'CREATE TABLE points_ledger_v2 '); // a renamed table comes back "quoted"
  if (v2 === sql) throw new Error('points_ledger: unexpected table SQL');
  await trx.raw(v2);
  await trx.raw('insert into points_ledger_v2 select * from points_ledger');
  await trx.raw('drop table points_ledger');
  await trx.raw('alter table points_ledger_v2 rename to points_ledger');
  for (const i of indexes) await trx.raw(i);
}

export const up = (knex) => withFksOff(knex, async (knex) => {
  await knex.schema.alterTable('organizations', (t) => {
    t.integer('points_expiry_months').notNullable().defaultTo(0);
    t.timestamp('points_expiry_since');
  });
  await knex.schema.alterTable('customer_profiles', (t) => t.integer('points_reminded_lot'));
  if (isPg(knex)) {
    await knex.raw('alter table points_ledger alter column order_id drop not null');
    await knex.raw('alter table points_ledger drop constraint points_ledger_kind_check');
    await knex.raw(`alter table points_ledger add constraint points_ledger_kind_check check (kind in (${NEW_KINDS}))`);
  } else {
    await rebuildLedger(knex, [['`order_id` integer not null', '`order_id` integer'], [`(${OLD_KINDS})`, `(${NEW_KINDS})`]]);
  }
  await knex.schema.alterTable('points_ledger', (t) => {
    t.integer('admin_id');
    t.string('note', 200);
  });
});

// Down drops the expiry and correction rows: the balances go back to what the orders alone gave.
export const down = (knex) => withFksOff(knex, async (knex) => {
  await knex('points_ledger').whereIn('kind', ['expire', 'adjust']).del();
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const c of ['note', 'admin_id']) await knex.raw(`alter table points_ledger drop column ${c}`);
  if (isPg(knex)) {
    await knex.raw('alter table points_ledger drop constraint points_ledger_kind_check');
    await knex.raw(`alter table points_ledger add constraint points_ledger_kind_check check (kind in (${OLD_KINDS}))`);
    await knex.raw('alter table points_ledger alter column order_id set not null');
  } else {
    await rebuildLedger(knex, [['`order_id` integer', '`order_id` integer not null'], [`(${NEW_KINDS})`, `(${OLD_KINDS})`]]);
  }
  await knex.raw('alter table customer_profiles drop column points_reminded_lot');
  for (const c of ['points_expiry_since', 'points_expiry_months']) await knex.raw(`alter table organizations drop column ${c}`);
});
