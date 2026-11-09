// Task 15: SKU and a short description for the demo catalogue (task 20 adds per-store uniqueness and barcode).
export async function up(knex) {
  await knex.schema.alterTable('products', (t) => {
    t.string('sku', 40);
    t.string('description', 300);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('products', (t) => {
    t.dropColumn('description');
    t.dropColumn('sku');
  });
}
