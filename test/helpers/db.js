// Test database: SQLite in memory by default. With TEST_DATABASE_URL set, each test file gets its own
// throwaway schema in that PostgreSQL database, because test files run in parallel.
import { randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/index.js';

export function testDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createDb({ databaseUrl: '', sqliteFile: ':memory:' });
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const db = createDb({
    databaseUrl: url,
    pg: {
      searchPath: [schema],
      pool: {
        afterCreate: (conn, done) => conn.query(`create schema if not exists ${schema}`, (err) => done(err?.code === '42P06' || err?.code === '23505' ? null : err, conn)),
      },
    },
  });
  return db; // shortcut: schemas are left behind (knex's destroy can't be wrapped); point this at a throwaway database
}

export const isPg = () => Boolean(process.env.TEST_DATABASE_URL);

// All table names, on either database.
export async function tableNames(db) {
  if (!isPg()) return (await db.raw("select name from sqlite_master where type = 'table'")).map((t) => t.name);
  return (await db.raw('select table_name from information_schema.tables where table_schema = current_schema()')).rows.map((t) => t.table_name);
}

// JSON columns: SQLite returns text, Postgres the parsed value.
export const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
