/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    // Nullable for existing cycles: unset is distinct from zero interest.
    table.decimal("interest_rate", 9, 6).nullable();
    table.string("interest_period", 16).nullable();
    table.string("interest_method", 16).nullable();
    table.decimal("cost_per_share", 18, 2).nullable();

    table.check("interest_rate >= 0 AND interest_rate <> 'NaN'::numeric", [], "cycles_interest_rate_check");
    table.check("interest_period IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')", [], "cycles_interest_period_check");
    table.check("interest_method IN ('SIMPLE', 'COMPOUND')", [], "cycles_interest_method_check");
    table.check(`(interest_rate IS NULL AND interest_period IS NULL AND interest_method IS NULL)
      OR (interest_rate IS NOT NULL AND interest_period IS NOT NULL AND interest_method IS NOT NULL)`,
    [], "cycles_interest_settings_complete_check");
    table.check("cost_per_share > 0 AND cost_per_share <> 'NaN'::numeric", [], "cycles_cost_per_share_check");
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    table.dropChecks([
      "cycles_interest_rate_check",
      "cycles_interest_period_check",
      "cycles_interest_method_check",
      "cycles_interest_settings_complete_check",
      "cycles_cost_per_share_check",
    ]);
    table.dropColumns("interest_rate", "interest_period", "interest_method", "cost_per_share");
  });
};
