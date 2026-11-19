// Task 49: cost price and profit. products.cost = what one unit cost the shop (integer so'm, null = not known);
// receiving with a "kirim narxi" turns it into the weighted average of the old and the new stock.
// order_items.unit_cost = the product's cost copied at the sale (payment), so a later change never rewrites old reports.
// Only super, owner and manager ever see either column.
export async function up(knex) {
  await knex.schema.alterTable('products', (t) => t.integer('cost'));
  await knex.schema.alterTable('order_items', (t) => t.integer('unit_cost'));
}

export async function down(knex) {
  await knex.raw('alter table products drop column cost');
  await knex.raw('alter table order_items drop column unit_cost');
}
