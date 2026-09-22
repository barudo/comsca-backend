const columns = "interest_rate, interest_period, interest_method, cost_per_share, updated_at";

exports.up = async function up(knex) {
  // Keep migration 010's group RLS policy and its original column grants.
  await knex.raw(`GRANT SELECT (${columns}) ON public.cycles TO comsca_group_reader`);
};

exports.down = async function down(knex) {
  await knex.raw(`REVOKE SELECT (${columns}) ON public.cycles FROM comsca_group_reader`);
};
