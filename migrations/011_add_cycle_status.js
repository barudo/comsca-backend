exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", table => {
    // Existing cycles and future inserts without an explicit status are inactive.
    table.string("status", 16).notNullable().defaultTo("inactive");
    table.check("status IN ('active', 'inactive', 'distributing')", [], "cycles_status_check");
  });
  // A database constraint also protects against concurrent activations.
  await knex.raw(`CREATE UNIQUE INDEX cycles_one_active_per_group
    ON public.cycles (group_id) WHERE status = 'active'`);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX public.cycles_one_active_per_group");
  await knex.schema.alterTable("cycles", table => {
    table.dropChecks("cycles_status_check");
    table.dropColumn("status");
  });
};
