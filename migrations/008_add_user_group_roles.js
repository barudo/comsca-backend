// Keep a self-contained copy of the registration function so rollback restores
// its previous behavior without depending on another migration's implementation.
function registrationFunction(includeRole) {
  return `
    CREATE OR REPLACE FUNCTION public.register_comsca_auth_user()
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
      INSERT INTO public.users (auth_user_id, group_id, first_name, family_name, phone${includeRole ? ", role" : ""})
        VALUES (NEW.id, new_group_id, btrim(registration ->> 'firstname'),
          btrim(registration ->> 'lastname'), phone_value${includeRole ? ", 'OWNER'" : ""});
      RETURN NEW;
    END;
    $$;
  `;
}

exports.up = async function up(knex) {
  await knex.schema.alterTable("users", (table) => {
    table.string("role", 16).notNullable().defaultTo("MEMBER");
    table.check("role IN ('OWNER', 'ADMIN', 'TREASURER', 'MEMBER', 'AUDITOR')", [], "users_role_check");
  });
  // Only the server-created first user of a new group receives ownership.
  // Existing users remain MEMBER; do not infer privileges from insertion order.
  await knex.raw(registrationFunction(true));
};

exports.down = async function down(knex) {
  await knex.raw(registrationFunction(false));
  await knex.schema.alterTable("users", (table) => {
    table.dropChecks("users_role_check");
    table.dropColumn("role");
  });
};
