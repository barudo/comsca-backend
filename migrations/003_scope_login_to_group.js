exports.up = async function up(knex) {
  // A dedicated role is necessary because the owner connection bypasses RLS.
  // Roles belong to the cluster and can survive a database/schema rebuild.
  await knex.raw(`
    DO $$
    BEGIN
      BEGIN
        CREATE ROLE comsca_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END;
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'comsca_login'
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
      ) THEN
        RAISE EXCEPTION 'Existing role comsca_login has unexpected privileges; reconcile its attributes before retrying';
      END IF;
    END
    $$;
  `);
  const { rows } = await knex.raw("SELECT current_user AS name");
  await knex.raw("GRANT comsca_login TO ??", [rows[0].name]);
  await knex.raw("GRANT USAGE ON SCHEMA public TO comsca_login");
  await knex.raw("GRANT SELECT (id, group_id, username, first_name, family_name, password) ON public.users TO comsca_login");
  await knex.raw(`CREATE POLICY login_group_select ON public.users
    FOR SELECT TO comsca_login
    USING (group_id = NULLIF(current_setting('app.group_id', true), '')::bigint)`);
  await knex.schema.alterTable("users", (table) => {
    table.unique(["group_id", "username"], "users_group_username_unique");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("users", (table) => {
    table.dropUnique(["group_id", "username"], "users_group_username_unique");
  });
  await knex.raw("DROP POLICY login_group_select ON public.users");
  await knex.raw("REVOKE SELECT (id, group_id, username, first_name, family_name, password) ON public.users FROM comsca_login");
  await knex.raw("REVOKE USAGE ON SCHEMA public FROM comsca_login");
  await knex.raw("DROP ROLE comsca_login");
};
