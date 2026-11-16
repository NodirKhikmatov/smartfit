// Task 44: the mall map. A store's floor stays the text on the store (stores.mall_floor, set by the mall admin);
// mall_floors gives each (mall, floor name) a row that a plan picture and kiosk spots can belong to, filled here from
// the floor values the stores already have. Pins are integer hundredths of a percent of the plan (0–10000), so
// they hold at any screen size and read the same on SQLite and Postgres: stores.map_x / map_y for a shop,
// mall_spots for a mall kiosk ("Siz shu yerdasiz"; its id goes in the kiosk link). No foreign keys on the stores
// columns (SQLite DROP COLUMN, like 024); mall_spots → mall_floors cascades.
export async function up(knex) {
  await knex.schema.createTable('mall_floors', (t) => {
    t.increments('id');
    t.integer('mall_id').notNullable();
    t.string('name', 20).notNullable(); // = stores.mall_floor
    t.string('plan_url'); // null = no plan: the directory works as before
    t.integer('plan_w');
    t.integer('plan_h');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['mall_id', 'name']);
  });
  await knex.schema.createTable('mall_spots', (t) => {
    t.increments('id');
    t.integer('mall_id').notNullable().index();
    t.integer('floor_id').notNullable().references('mall_floors.id').onDelete('CASCADE');
    t.string('label', 60).notNullable();
    t.integer('x').notNullable();
    t.integer('y').notNullable();
  });
  await knex.schema.alterTable('stores', (t) => {
    t.integer('map_x');
    t.integer('map_y');
  });
  const floors = await knex('stores').whereNotNull('mall_id').whereNotNull('mall_floor').distinct('mall_id', 'mall_floor as name');
  if (floors.length) await knex('mall_floors').insert(floors);
}

export async function down(knex) {
  for (const col of ['map_y', 'map_x']) await knex.raw(`alter table stores drop column ${col}`); // native DROP COLUMN (see 009)
  await knex.schema.dropTable('mall_spots');
  await knex.schema.dropTable('mall_floors');
}
