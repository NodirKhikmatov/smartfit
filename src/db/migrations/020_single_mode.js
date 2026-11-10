// Task 30: whole outfit or single items. `mode` (outfit | single) on the results screen log (so orders split by it),
// the funnel events and the missed demand rows. null = not known (older clients, the catalogue, the cart). No personal data.
const TABLES = ['recommendation_logs', 'funnel_events', 'missed_demand'];

export async function up(knex) {
  for (const table of TABLES) await knex.schema.alterTable(table, (t) => t.string('mode', 8));
}

export async function down(knex) {
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  for (const table of TABLES) await knex.raw(`alter table ${table} drop column mode`);
}
