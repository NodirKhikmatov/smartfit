// Task 14: optional Russian product name, shown when the customer or admin uses Russian (else `name`).
export async function up(knex) {
  await knex.schema.alterTable('products', (t) => t.string('name_ru', 120));
}

export async function down(knex) {
  await knex.schema.alterTable('products', (t) => t.dropColumn('name_ru'));
}
