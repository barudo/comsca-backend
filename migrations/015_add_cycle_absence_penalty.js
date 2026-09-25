/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    table.decimal("absence_penalty", 18, 2).nullable();
    table.decimal("required_monthly_contribution", 18, 2).nullable();
    table.check(
      "absence_penalty >= 0 AND absence_penalty <> 'NaN'::numeric",
      [],
      "cycles_absence_penalty_check",
    );
    table.check(
      "required_monthly_contribution >= 0 AND required_monthly_contribution <> 'NaN'::numeric",
      [],
      "cycles_required_monthly_contribution_check",
    );
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable("cycles", (table) => {
    table.dropChecks([
      "cycles_absence_penalty_check",
      "cycles_required_monthly_contribution_check",
    ]);
    table.dropColumns("absence_penalty", "required_monthly_contribution");
  });
};
