exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", table => {
    table.boolean("transactions_frozen").notNullable().defaultTo(true);
    table.timestamp("transactions_frozen_at", { useTz: true });
    table.bigInteger("transactions_frozen_by").references("id").inTable("users");
    table.timestamp("transactions_unfrozen_at", { useTz: true });
    table.bigInteger("transactions_unfrozen_by").references("id").inTable("users");
  });
  await knex.raw(`
    CREATE TABLE public.cycle_freeze_logs (
      id bigserial PRIMARY KEY, group_id bigint NOT NULL, cycle_id bigint NOT NULL,
      performed_by bigint NOT NULL REFERENCES public.users(id),
      action text NOT NULL CHECK(action IN ('FREEZE','UNFREEZE')),
      previous_state boolean NOT NULL, new_state boolean NOT NULL,
      CHECK(previous_state<>new_state AND new_state=(action='FREEZE')),
      reason text CHECK(length(reason)<=4000), performed_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(group_id,cycle_id) REFERENCES public.cycles(group_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX cycle_freeze_logs_cycle_idx ON public.cycle_freeze_logs(group_id,cycle_id,id);
    ALTER TABLE public.cycle_freeze_logs ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.cycle_freeze_logs TO comsca_group_reader;
    CREATE POLICY cycle_freeze_logs_group_read ON public.cycle_freeze_logs FOR SELECT TO comsca_group_reader
      USING(group_id=nullif(current_setting('app.group_id',true),'')::bigint);
    GRANT SELECT(transactions_frozen) ON public.cycles TO comsca_group_reader;
  `);
};
exports.down = async function down(knex) {
  await knex.raw(`LOCK TABLE public.cycle_freeze_logs IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.cycle_freeze_logs) THEN
      RAISE EXCEPTION 'Rollback would lose freeze audit records' USING ERRCODE='23514';
    END IF; END $$;`);
  await knex.schema.dropTable("cycle_freeze_logs");
  await knex.schema.alterTable("cycles", table => {
    table.dropColumns("transactions_frozen", "transactions_frozen_at", "transactions_frozen_by", "transactions_unfrozen_at", "transactions_unfrozen_by");
  });
};
