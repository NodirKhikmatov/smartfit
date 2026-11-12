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
import * as demand from './migrations/014_demand.js';
import * as reserve from './migrations/015_reserve.js';
import * as promos from './migrations/016_promos.js';
import * as profiles from './migrations/017_profiles.js';
import * as staff from './migrations/018_staff.js';
import * as sizeMethods from './migrations/019_size_methods.js';
import * as singleMode from './migrations/020_single_mode.js';
import * as stockAlerts from './migrations/021_stock_alerts.js';
import * as qrScans from './migrations/022_qr_scans.js';
import * as categories from './migrations/023_categories.js';
import * as malls from './migrations/024_malls.js';
import * as occasion from './migrations/025_occasion.js';
import * as points from './migrations/026_points.js';
import * as instalments from './migrations/027_instalments.js';
import * as mallCart from './migrations/028_mall_cart.js';

// Postgres returns bigint (count(*), Telegram chat ids, Payme ms times) as strings; all of ours fit in a double.
pg.types.setTypeParser(20, Number);

// Migrations are listed in code so they load the same way from any cwd.
const migrations = { '001_init': init, '002_cart': cart, '003_payments': payments, '004_notify': notify, '005_pilot': pilot, '006_i18n': i18n, '007_catalogue': catalogue, '008_handoff': handoff, '009_team': team, '010_inventory': inventory, '011_hardening': hardening, '012_orgs': orgs, '013_returns': returns, '014_demand': demand, '015_reserve': reserve, '016_promos': promos, '017_profiles': profiles, '018_staff': staff, '019_size_methods': sizeMethods, '020_single_mode': singleMode, '021_stock_alerts': stockAlerts, '022_qr_scans': qrScans, '023_categories': categories, '024_malls': malls, '025_occasion': occasion, '026_points': points, '027_instalments': instalments, '028_mall_cart': mallCart };
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
