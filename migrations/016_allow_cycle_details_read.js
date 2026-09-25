const columns = "name, description, absence_penalty, required_monthly_contribution";

exports.up = async function up(knex) {
  await knex.raw(`GRANT SELECT (${columns}) ON public.cycles TO comsca_group_reader`);
};

exports.down = async function down(knex) {
  await knex.raw(`REVOKE SELECT (${columns}) ON public.cycles FROM comsca_group_reader`);
};
