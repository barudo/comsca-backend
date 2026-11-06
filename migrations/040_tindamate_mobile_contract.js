// Legacy package rows, token hashes, ciphertext and key material are deliberately untouched.
exports.up = async knex => {
  await knex.raw(`
    ALTER TABLE public.tindamate_google_play_purchases ALTER COLUMN package_name SET DEFAULT 'com.vebatech.tindamate';
    ALTER TABLE public.tindamate_google_play_purchases DROP COLUMN order_id, DROP COLUMN purchase_state, DROP COLUMN purchased_at;
    ALTER TABLE public.tindamate_license_events DROP COLUMN details;
  `);
};
exports.down = async knex => {
  await knex.raw(`
    ALTER TABLE public.tindamate_google_play_purchases ALTER COLUMN package_name SET DEFAULT 'com.mobilepos.scanner';
    ALTER TABLE public.tindamate_google_play_purchases ADD COLUMN order_id text, ADD COLUMN purchase_state text, ADD COLUMN purchased_at timestamptz;
    ALTER TABLE public.tindamate_license_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
};
