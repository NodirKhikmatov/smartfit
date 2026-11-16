// Task 45: plans. organizations.plan (start | pro | biznes, see src/plans.js), trial_until / paid_until (Tashkent days,
// inclusive; null = no end), a note only super writes, and when the owner hid the first-run checklist.
// Every organisation that exists now (the demo ones, the pilot's) gets the biggest plan with no end date, so nothing
// limits or locks on upgrade; the column default does the same for any row inserted without a plan. New organisations
// made in the app get a 14-day Pro trial (src/plans.js trialRow). Down drops the columns (native DROP COLUMN, see 009).
export async function up(knex) {
  await knex.schema.alterTable('organizations', (t) => {
    t.string('plan', 20).notNullable().defaultTo('biznes');
    t.string('trial_until', 10);
    t.string('paid_until', 10);
    t.string('plan_note', 300);
    t.string('checklist_dismissed_at');
  });
}

export async function down(knex) {
  for (const col of ['checklist_dismissed_at', 'plan_note', 'paid_until', 'trial_until', 'plan']) await knex.raw(`alter table organizations drop column ${col}`);
}
