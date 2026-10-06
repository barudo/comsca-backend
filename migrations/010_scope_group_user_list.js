const userColumns = "id, group_id, first_name, family_name, username, email, phone, address, role, created_at, updated_at";

exports.up = async function up(knex) {
  // Roles belong to the cluster and can survive a database/schema rebuild.
  await knex.raw(`
    DO $$
    BEGIN
      BEGIN
        CREATE ROLE comsca_group_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END;
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'comsca_group_reader'
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
      ) THEN
        RAISE EXCEPTION 'Existing role comsca_group_reader has unexpected privileges; reconcile its attributes before retrying';
      END IF;
    END
    $$;
  `);
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
