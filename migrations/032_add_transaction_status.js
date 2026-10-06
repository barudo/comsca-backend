exports.up = async function up(knex) {
  await knex.schema.alterTable("transactions", table => {
    table.string("status", 16).notNullable().defaultTo("active");
    table.check("status IN ('active', 'voided')", [], "transactions_status_check");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("transactions", table => {
    table.dropChecks("transactions_status_check");
    table.dropColumn("status");
  });
};
