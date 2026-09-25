exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", table => {
    table.decimal("starting_subscription", 18, 2).nullable();
    table.integer("maximum_monthly_shares").nullable();
    table.check("starting_subscription >= 0 AND starting_subscription <> 'NaN'::numeric", [],
      "cycles_starting_subscription_check");
    table.check("maximum_monthly_shares > 0", [], "cycles_maximum_monthly_shares_check");
  });
  await knex.raw("GRANT SELECT (starting_subscription, maximum_monthly_shares) ON public.cycles TO comsca_group_reader");
};

exports.down = async function down(knex) {
  await knex.raw("REVOKE SELECT (starting_subscription, maximum_monthly_shares) ON public.cycles FROM comsca_group_reader");
  await knex.schema.alterTable("cycles", table => {
    table.dropChecks(["cycles_starting_subscription_check", "cycles_maximum_monthly_shares_check"]);
    table.dropColumns("starting_subscription", "maximum_monthly_shares");
  });
};
