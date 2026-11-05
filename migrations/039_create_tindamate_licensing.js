exports.up = async knex => {
  await knex.raw(`
    CREATE TABLE public.tindamate_google_play_purchases (
      id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
      encrypted_token text NOT NULL, package_name text NOT NULL DEFAULT 'com.mobilepos.scanner',
      product_id text NOT NULL DEFAULT 'tindamate_pro_lifetime', order_id text, purchase_state text,
      purchased_at timestamptz, last_verified_at timestamptz, revoked_at timestamptz, status text NOT NULL CHECK(status IN ('PENDING','VERIFIED','REVOKED','REFUNDED')),
      acknowledgement_status text NOT NULL DEFAULT 'PENDING' CHECK(acknowledgement_status IN ('PENDING','ACKNOWLEDGED','RETRY')),
      acknowledgement_attempts integer NOT NULL DEFAULT 0 CHECK(acknowledgement_attempts>=0),
      acknowledgement_attempted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.tindamate_entitlements (
      id uuid PRIMARY KEY, purchase_id uuid NOT NULL UNIQUE REFERENCES public.tindamate_google_play_purchases(id) ON DELETE RESTRICT,
      status text NOT NULL CHECK(status IN ('VERIFIED','REVOKED')), issued_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.tindamate_license_events (
      id uuid PRIMARY KEY, dedupe_key text UNIQUE, event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, purchase_id uuid REFERENCES public.tindamate_google_play_purchases(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.tindamate_google_play_purchases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.tindamate_entitlements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.tindamate_license_events ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.tindamate_google_play_purchases, public.tindamate_entitlements, public.tindamate_license_events FROM PUBLIC;
    DO $$ DECLARE role_name text; BEGIN
      FOREACH role_name IN ARRAY ARRAY['anon','authenticated','comsca_group_reader'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('REVOKE ALL ON public.tindamate_google_play_purchases, public.tindamate_entitlements, public.tindamate_license_events FROM %I', role_name);
        END IF;
      END LOOP;
    END $$;
  `);
};
exports.down = async knex => knex.raw('DROP TABLE public.tindamate_license_events, public.tindamate_entitlements, public.tindamate_google_play_purchases');
