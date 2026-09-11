exports.up = async function up(knex) {
  if (!await knex.schema.withSchema("auth").hasTable("users")) {
    throw new Error("Registration requires Supabase Auth (auth.users). Use a local Supabase instance for development.");
  }
  await knex.schema.alterTable("users", (table) => {
    table.string("username", 255).nullable().alter();
    table.string("email", 320).nullable().alter();
    table.string("password", 255).nullable().alter();
    table.uuid("auth_user_id").unique().references("id").inTable("auth.users").onDelete("CASCADE");
  });
  await knex.raw(`
    CREATE FUNCTION public.register_comsca_auth_user()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
    DECLARE
      registration jsonb := NEW.raw_user_meta_data -> 'comsca_registration';
      new_group_id bigint;
      phone_value text := '+' || ltrim(NEW.phone, '+');
    BEGIN
      IF registration IS NULL THEN RETURN NEW; END IF;
      IF jsonb_typeof(registration) IS DISTINCT FROM 'object'
        OR jsonb_typeof(registration -> 'firstname') IS DISTINCT FROM 'string'
        OR jsonb_typeof(registration -> 'lastname') IS DISTINCT FROM 'string'
        OR jsonb_typeof(registration -> 'groupName') IS DISTINCT FROM 'string'
        OR jsonb_typeof(registration -> 'slug') IS DISTINCT FROM 'string'
        OR length(btrim(registration ->> 'firstname')) NOT BETWEEN 1 AND 255
        OR length(btrim(registration ->> 'lastname')) NOT BETWEEN 1 AND 255
        OR length(btrim(registration ->> 'groupName')) NOT BETWEEN 1 AND 255
        OR (registration ->> 'slug') !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]){0,1}$'
        OR (registration ->> 'slug') IN ('www', 'api', 'app', 'admin', 'auth')
        OR phone_value IS NULL OR phone_value !~ '^[+]639[0-9]{9}$'
      THEN
        RAISE EXCEPTION 'Invalid COMSCA registration metadata' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.groups (name, slug)
        VALUES (btrim(registration ->> 'groupName'), registration ->> 'slug')
        RETURNING id INTO new_group_id;
      INSERT INTO public.users (auth_user_id, group_id, first_name, family_name, phone)
        VALUES (NEW.id, new_group_id, btrim(registration ->> 'firstname'),
          btrim(registration ->> 'lastname'), phone_value);
      RETURN NEW;
    END;
    $$;
  `);
  await knex.raw("REVOKE ALL ON FUNCTION public.register_comsca_auth_user() FROM PUBLIC");
  await knex.raw(`CREATE TRIGGER on_comsca_auth_user_created
    AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.register_comsca_auth_user()`);
};

exports.down = async function down(knex) {
  // Restoring the old required fields must not delete or fabricate credentials.
  const incompatible = await knex("users").whereNull("username").orWhereNull("email").orWhereNull("password").orWhereNotNull("auth_user_id").first("id");
  if (incompatible) throw new Error("Cannot roll back registration while Supabase-linked users or null legacy credentials exist");
  await knex.raw("DROP TRIGGER on_comsca_auth_user_created ON auth.users");
  await knex.raw("DROP FUNCTION public.register_comsca_auth_user()");
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("auth_user_id");
    table.string("username", 255).notNullable().alter();
    table.string("email", 320).notNullable().alter();
    table.string("password", 255).notNullable().alter();
  });
};
