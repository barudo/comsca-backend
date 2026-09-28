exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_group_id_cycle_unique UNIQUE(group_id,id,cycle_id);
    ALTER TABLE public.transaction_entries
      ADD COLUMN user_id bigint,
      ADD COLUMN cycle_id bigint,
      ADD CONSTRAINT transaction_entries_member_requires_cycle CHECK(user_id IS NULL OR cycle_id IS NOT NULL),
      ADD CONSTRAINT transaction_entries_group_user_fk FOREIGN KEY(group_id,user_id)
        REFERENCES public.users(group_id,id) ON DELETE RESTRICT,
      ADD CONSTRAINT transaction_entries_parent_cycle_fk FOREIGN KEY(group_id,transaction_id,cycle_id)
        REFERENCES public.transactions(group_id,id,cycle_id) ON DELETE RESTRICT,
      ADD CONSTRAINT transaction_entries_cycle_member_fk FOREIGN KEY(cycle_id,user_id)
        REFERENCES public.cycle_members(cycle_id,user_id) ON DELETE RESTRICT;
    CREATE INDEX transaction_entries_cycle_user_idx ON public.transaction_entries(cycle_id,user_id);
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    LOCK TABLE public.transaction_entries IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM public.transaction_entries WHERE user_id IS NOT NULL OR cycle_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Rollback would lose transaction entry member data' USING ERRCODE='23514';
      END IF;
    END $$;
    ALTER TABLE public.transaction_entries DROP COLUMN user_id, DROP COLUMN cycle_id;
    ALTER TABLE public.transactions DROP CONSTRAINT transactions_group_id_cycle_unique;
  `);
};
