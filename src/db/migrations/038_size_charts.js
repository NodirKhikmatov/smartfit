// Task 48: a shop's own size chart. One row per organisation and scope: a size kind ('clothes', 'shoes', 'kids',
// 'kids_shoes') is the organisation's default for that kind, 'c<category id>' one category's own chart. `data` is the
// JSON of src/size/chart.js (per group, per size, a [min, max] cm range per measure). Only the shop's own figures:
// nothing about any customer.
export async function up(knex) {
  await knex.schema.createTable('size_charts', (t) => {
    t.increments('id');
    t.integer('organization_id').notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('category_id').references('categories.id').onDelete('CASCADE'); // null = the organisation's default
    t.string('scope', 20).notNullable();
    t.string('kind', 12).notNullable();
    t.text('data').notNullable();
    t.integer('updated_by');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['organization_id', 'scope']);
    t.check("?? in ('clothes', 'shoes', 'kids', 'kids_shoes')", ['kind'], 'size_charts_kind_check');
  });
}

export async function down(knex) {
  await knex.schema.dropTable('size_charts');
}
