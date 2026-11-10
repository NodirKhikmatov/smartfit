// Task 29: how the size was found (photo kind, usual size, tape, height+weight) per results screen, for the
// accuracy-per-method view; and the new no-photo numbers in the Telegram profile. No photo, ever.
export async function up(knex) {
  await knex.schema.alterTable('recommendation_logs', (t) => {
    t.string('size_method', 8); // full | torso | upper | usual | tape | body | profile; null = not told (older clients)
  });
  await knex.schema.alterTable('customer_profiles', (t) => {
    t.string('fit', 8); // tight | regular | loose
    t.integer('jeans'); // usual jeans waist, W26–W40
    t.integer('chest'); // cm, from a tape
    t.integer('waist');
    t.integer('hips');
  });
}

export async function down(knex) {
  // Native DROP COLUMN (see 009): knex's SQLite rebuild would cascade-delete through the foreign keys.
  await knex.raw('alter table recommendation_logs drop column size_method');
  for (const col of ['fit', 'jeans', 'chest', 'waist', 'hips']) await knex.raw(`alter table customer_profiles drop column ${col}`);
}
