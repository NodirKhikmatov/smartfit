import knex from 'knex';
import * as init from './migrations/001_init.js';
import * as cart from './migrations/002_cart.js';
import * as payments from './migrations/003_payments.js';
import * as notify from './migrations/004_notify.js';

// Migrations are listed in code so they load the same way from any cwd.
const migrations = { '001_init': init, '002_cart': cart, '003_payments': payments, '004_notify': notify };
const migrationSource = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name],
};

// DATABASE_URL set → PostgreSQL (needs `pg`, added in task 11); otherwise SQLite.
export function createDb({ databaseUrl = process.env.DATABASE_URL, sqliteFile = process.env.SQLITE_FILE || './smartfit.db' } = {}) {
  const common = { migrations: { migrationSource } };
  if (databaseUrl) return knex({ ...common, client: 'pg', connection: databaseUrl });
  return knex({
    ...common,
    client: 'better-sqlite3',
    connection: { filename: sqliteFile },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        conn.pragma('foreign_keys = ON'); // SQLite ignores FKs unless enabled per connection
        done();
      },
    },
  });
}
