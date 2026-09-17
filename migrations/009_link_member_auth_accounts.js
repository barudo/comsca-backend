exports.up = async function up(knex) {
  await knex.raw(`CREATE FUNCTION public.link_comsca_member_auth_account()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
    DECLARE
      auth_record record;
      member jsonb;
    BEGIN
      -- Auth may set app metadata and confirmation after its initial INSERT.
      SELECT * INTO auth_record FROM auth.users WHERE id = NEW.id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      member := auth_record.raw_app_meta_data -> 'comsca_member';
      IF member IS NULL THEN RETURN NULL; END IF;
      IF jsonb_typeof(member) IS DISTINCT FROM 'object'
        OR COALESCE(member ->> 'user_id', '') !~ '^[1-9][0-9]{0,18}$'
        OR COALESCE(member ->> 'group_id', '') !~ '^[1-9][0-9]{0,18}$'
        OR COALESCE(member ->> 'actor_id', '') !~ '^[1-9][0-9]{0,18}$'
        OR auth_record.phone_confirmed_at IS NULL
      THEN
        RAISE EXCEPTION 'Invalid member account provisioning metadata' USING ERRCODE = '23514';
      END IF;
      -- Only server-controlled app metadata is trusted, never user metadata.
      PERFORM id FROM public.users
        WHERE id = (member ->> 'actor_id')::bigint
          AND group_id = (member ->> 'group_id')::bigint
          AND role IN ('OWNER', 'ADMIN')
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Group account provisioning is not authorized' USING ERRCODE = '23514';
      END IF;
      UPDATE public.users SET auth_user_id = auth_record.id, updated_at = clock_timestamp()
        WHERE id = (member ->> 'user_id')::bigint
          AND group_id = (member ->> 'group_id')::bigint
          AND phone = '+' || ltrim(auth_record.phone, '+')
          AND auth_user_id IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Member is unavailable for account provisioning' USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$`);
  await knex.raw("REVOKE ALL ON FUNCTION public.link_comsca_member_auth_account() FROM PUBLIC");
  await knex.raw(`CREATE CONSTRAINT TRIGGER on_comsca_member_auth_created
    AFTER INSERT ON auth.users DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.link_comsca_member_auth_account()`);
};

exports.down = async function down(knex) {
  await knex.raw("DROP TRIGGER IF EXISTS on_comsca_member_auth_created ON auth.users");
  await knex.raw("DROP FUNCTION IF EXISTS public.link_comsca_member_auth_account()");
};
