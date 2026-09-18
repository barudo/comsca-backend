const userColumns = "id, group_id, first_name, family_name, username, email, phone, address, role, created_at, updated_at";

exports.up = async function up(knex) {
  await knex.raw("CREATE ROLE comsca_group_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
  const { rows } = await knex.raw("SELECT current_user AS name");
  await knex.raw("GRANT comsca_group_reader TO ??", [rows[0].name]);
  await knex.raw("GRANT USAGE ON SCHEMA public TO comsca_group_reader");
  await knex.raw(`GRANT SELECT (${userColumns}) ON public.users TO comsca_group_reader`);
  await knex.raw("GRANT SELECT (id, group_id, created_at) ON public.cycles TO comsca_group_reader");
  await knex.raw("GRANT SELECT (cycle_id, user_id) ON public.cycle_members TO comsca_group_reader");
  for (const table of ["users", "cycles"]) {
    await knex.raw(`CREATE POLICY group_reader_select ON public.${table}
      FOR SELECT TO comsca_group_reader
      USING (group_id = NULLIF(current_setting('app.group_id', true), '')::bigint)`);
  }
  await knex.raw(`CREATE POLICY group_reader_select ON public.cycle_members
    FOR SELECT TO comsca_group_reader
    USING (EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = cycle_id)
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = user_id))`);
};

exports.down = async function down(knex) {
  for (const table of ["cycle_members", "cycles", "users"]) {
    await knex.raw(`DROP POLICY group_reader_select ON public.${table}`);
  }
  await knex.raw(`REVOKE SELECT (${userColumns}) ON public.users FROM comsca_group_reader`);
  await knex.raw("REVOKE SELECT (id, group_id, created_at) ON public.cycles FROM comsca_group_reader");
  await knex.raw("REVOKE SELECT (cycle_id, user_id) ON public.cycle_members FROM comsca_group_reader");
  await knex.raw("REVOKE USAGE ON SCHEMA public FROM comsca_group_reader");
  await knex.raw("DROP ROLE comsca_group_reader");
};
