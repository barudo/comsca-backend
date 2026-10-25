exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE public.accounts ADD COLUMN distribution_role text
      CHECK(distribution_role IN ('MEMBER_CAPITAL','RECEIVABLE','CASH','EARNINGS','DISTRIBUTION_PAYABLE'));
    CREATE UNIQUE INDEX accounts_distribution_role_unique ON public.accounts(group_id,cycle_id,distribution_role)
      WHERE distribution_role IN ('EARNINGS','DISTRIBUTION_PAYABLE');
    CREATE TABLE public.cycle_distribution_declarations (
      group_id bigint NOT NULL, cycle_id bigint NOT NULL, declared_by bigint NOT NULL,
      summary jsonb NOT NULL, closing_transaction_ids bigint[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(group_id,cycle_id),
      FOREIGN KEY(group_id,cycle_id) REFERENCES public.cycles(group_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,declared_by) REFERENCES public.users(group_id,id) ON DELETE RESTRICT
    );
    CREATE TABLE public.cycle_distributions (
      id bigserial PRIMARY KEY, group_id bigint NOT NULL, cycle_id bigint NOT NULL, user_id bigint NOT NULL,
      capital_amount numeric(18,2) NOT NULL, earnings_amount numeric(18,2) NOT NULL,
      gross_amount numeric(18,2) NOT NULL, loan_deduction numeric(18,2) NOT NULL DEFAULT 0,
      contribution_deduction numeric(18,2) NOT NULL DEFAULT 0, penalty_deduction numeric(18,2) NOT NULL DEFAULT 0,
      other_deduction numeric(18,2) NOT NULL DEFAULT 0, total_deductions numeric(18,2) NOT NULL DEFAULT 0,
      net_amount numeric(18,2) NOT NULL, paid_amount numeric(18,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending' CHECK(status='pending'),
      distribution_transaction_id bigint, payable_account_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(cycle_id,user_id),
      FOREIGN KEY(group_id,cycle_id) REFERENCES public.cycle_distribution_declarations(group_id,cycle_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,user_id) REFERENCES public.users(group_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(cycle_id,user_id) REFERENCES public.cycle_members(cycle_id,user_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,distribution_transaction_id,cycle_id) REFERENCES public.transactions(group_id,id,cycle_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,payable_account_id) REFERENCES public.accounts(group_id,id) ON DELETE RESTRICT,
      CHECK(capital_amount>=0 AND capital_amount<>'NaN'::numeric AND earnings_amount<>'NaN'::numeric
        AND gross_amount=capital_amount+earnings_amount AND net_amount=gross_amount-total_deductions AND net_amount>=0
        AND loan_deduction>=0 AND loan_deduction<>'NaN'::numeric AND contribution_deduction=0 AND penalty_deduction=0 AND other_deduction=0
        AND total_deductions=loan_deduction AND paid_amount=0)
    );
    ALTER TABLE public.cycle_distribution_declarations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.cycle_distributions ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.cycle_distribution_declarations, public.cycle_distributions TO comsca_group_reader;
    CREATE POLICY cycle_distribution_declarations_group_read ON public.cycle_distribution_declarations
      FOR SELECT TO comsca_group_reader USING(group_id=nullif(current_setting('app.group_id',true),'')::bigint);
    CREATE POLICY cycle_distributions_group_read ON public.cycle_distributions
      FOR SELECT TO comsca_group_reader USING(group_id=nullif(current_setting('app.group_id',true),'')::bigint);
    CREATE FUNCTION public.prevent_distribution_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN RAISE EXCEPTION 'Declared distributions are immutable' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER cycle_distributions_immutable BEFORE UPDATE OR DELETE ON public.cycle_distributions
      FOR EACH ROW EXECUTE FUNCTION public.prevent_distribution_mutation();
    CREATE TRIGGER cycle_distribution_declarations_immutable BEFORE UPDATE OR DELETE ON public.cycle_distribution_declarations
      FOR EACH ROW EXECUTE FUNCTION public.prevent_distribution_mutation();
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`LOCK TABLE public.cycle_distributions, public.cycle_distribution_declarations IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.cycle_distribution_declarations) THEN
      RAISE EXCEPTION 'Rollback would lose distribution accounting audit records' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE public.cycle_distributions, public.cycle_distribution_declarations;
    DROP FUNCTION public.prevent_distribution_mutation();
    DROP INDEX public.accounts_distribution_role_unique;
    ALTER TABLE public.accounts DROP COLUMN distribution_role;`);
};
