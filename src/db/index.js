import knex from 'knex';
import pg from 'pg';
import * as init from './migrations/001_init.js';
import * as cart from './migrations/002_cart.js';
import * as payments from './migrations/003_payments.js';
import * as notify from './migrations/004_notify.js';
import * as pilot from './migrations/005_pilot.js';
import * as i18n from './migrations/006_i18n.js';
import * as catalogue from './migrations/007_catalogue.js';
import * as handoff from './migrations/008_handoff.js';
import * as team from './migrations/009_team.js';
import * as inventory from './migrations/010_inventory.js';
import * as hardening from './migrations/011_hardening.js';
import * as orgs from './migrations/012_orgs.js';
import * as returns from './migrations/013_returns.js';

// Postgres returns bigint (count(*), Telegram chat ids, Payme ms times) as strings; all of ours fit in a double.
pg.types.setTypeParser(20, Number);

// Migrations are listed in code so they load the same way from any cwd.
const migrations = { '001_init': init, '002_cart': cart, '003_payments': payments, '004_notify': notify, '005_pilot': pilot, '006_i18n': i18n, '007_catalogue': catalogue, '008_handoff': handoff, '009_team': team, '010_inventory': inventory, '011_hardening': hardening, '012_orgs': orgs, '013_returns': returns };
const migrationSource = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name],
};

// DATABASE_URL set → PostgreSQL; otherwise SQLite. `pg` passes extra knex options (tests use searchPath + pool).
export function createDb({ databaseUrl = process.env.DATABASE_URL, sqliteFile = process.env.SQLITE_FILE || './smartfit.db', pg = {} } = {}) {
  const common = { migrations: { migrationSource } };
  if (databaseUrl) return knex({ ...common, client: 'pg', connection: databaseUrl, ...pg });
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
