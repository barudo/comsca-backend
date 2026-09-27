const columns = "id, group_id, cycle_id, code, name, type, description, created_at, updated_at";

exports.up = async function up(knex) {
  await knex.raw(`GRANT SELECT (${columns}) ON public.accounts TO comsca_group_reader`);
  await knex.raw(`CREATE POLICY group_reader_select ON public.accounts
    FOR SELECT TO comsca_group_reader
    USING (group_id = NULLIF(current_setting('app.group_id', true), '')::bigint)`);
};

exports.down = async function down(knex) {
  await knex.raw("DROP POLICY group_reader_select ON public.accounts");
  await knex.raw(`REVOKE SELECT (${columns}) ON public.accounts FROM comsca_group_reader`);
};
