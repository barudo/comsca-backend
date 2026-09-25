/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    // Keep existing cycles and inserts valid without requiring a backfill.
    table.string("name", 255).nullable();
    table.text("description").nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    table.dropColumns("name", "description");
  });
};
