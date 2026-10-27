const entitlementCheck = `capital_amount>=0 AND capital_amount<>'NaN'::numeric AND earnings_amount<>'NaN'::numeric
  AND gross_amount=capital_amount+earnings_amount AND net_amount=gross_amount-total_deductions AND net_amount>=0
  AND loan_deduction>=0 AND loan_deduction<>'NaN'::numeric AND contribution_deduction=0 AND penalty_deduction=0 AND other_deduction=0
  AND total_deductions=loan_deduction`;
exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_group_id_cycle_payout_unique UNIQUE(group_id,id,cycle_id);
    ALTER TABLE public.cycle_distributions ADD CONSTRAINT distributions_payout_member_unique UNIQUE(group_id,cycle_id,user_id);
    ALTER TABLE public.cycle_distributions DROP CONSTRAINT cycle_distributions_status_check, DROP CONSTRAINT cycle_distributions_check;
    ALTER TABLE public.cycle_distributions ADD CONSTRAINT cycle_distributions_entitlement_check CHECK(${entitlementCheck}),
      ADD CONSTRAINT cycle_distributions_payment_check CHECK(paid_amount<>'NaN'::numeric AND paid_amount>=0 AND paid_amount<=net_amount
        AND ((paid_amount=0 AND status='pending') OR (paid_amount>0 AND paid_amount<net_amount AND status='partial') OR (paid_amount>0 AND paid_amount=net_amount AND status='paid')));
    CREATE TABLE public.member_payouts (
      id bigserial PRIMARY KEY, group_id bigint NOT NULL, cycle_id bigint NOT NULL, user_id bigint NOT NULL,
      transaction_id bigint NOT NULL UNIQUE, debit bigint NOT NULL, credit bigint NOT NULL,
      amount numeric(18,2) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric),
      idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key !~ '[^ -~]'),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(cycle_id,idempotency_key),
      FOREIGN KEY(group_id,cycle_id) REFERENCES public.cycles(group_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,cycle_id,user_id) REFERENCES public.cycle_distributions(group_id,cycle_id,user_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,transaction_id,cycle_id) REFERENCES public.transactions(group_id,id,cycle_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,debit,cycle_id) REFERENCES public.accounts(group_id,id,cycle_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,credit,cycle_id) REFERENCES public.accounts(group_id,id,cycle_id) ON DELETE RESTRICT,
      CHECK(debit<>credit)
    );
    ALTER TABLE public.member_payouts ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.member_payouts TO comsca_group_reader;
    CREATE POLICY member_payouts_group_read ON public.member_payouts FOR SELECT TO comsca_group_reader
      USING(group_id=nullif(current_setting('app.group_id',true),'')::bigint);
    CREATE TRIGGER member_payouts_immutable BEFORE UPDATE OR DELETE ON public.member_payouts
      FOR EACH ROW EXECUTE FUNCTION public.prevent_distribution_mutation();
    CREATE FUNCTION public.guard_distribution_payment_state() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Declared distributions are immutable' USING ERRCODE='23514'; END IF;
      IF (to_jsonb(NEW)-ARRAY['paid_amount','status','updated_at']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['paid_amount','status','updated_at']) OR NEW.paid_amount<OLD.paid_amount THEN
        RAISE EXCEPTION 'Declared entitlement is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.paid_amount IS DISTINCT FROM (SELECT COALESCE(sum(amount),0) FROM public.member_payouts
        WHERE group_id=NEW.group_id AND cycle_id=NEW.cycle_id AND user_id=NEW.user_id) THEN
        RAISE EXCEPTION 'Paid amount must match payout audit history' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER cycle_distributions_immutable ON public.cycle_distributions;
    CREATE TRIGGER cycle_distributions_immutable BEFORE UPDATE OR DELETE ON public.cycle_distributions
      FOR EACH ROW EXECUTE FUNCTION public.guard_distribution_payment_state();
  `);
};
exports.down = async function down(knex) {
  await knex.raw(`LOCK TABLE public.member_payouts, public.cycle_distributions IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.member_payouts) OR EXISTS(SELECT 1 FROM public.cycle_distributions WHERE paid_amount<>0 OR status<>'pending') THEN
      RAISE EXCEPTION 'Rollback would lose payout audit records' USING ERRCODE='23514'; END IF; END $$;
    DROP TRIGGER cycle_distributions_immutable ON public.cycle_distributions;
    DROP FUNCTION public.guard_distribution_payment_state();
    CREATE TRIGGER cycle_distributions_immutable BEFORE UPDATE OR DELETE ON public.cycle_distributions
      FOR EACH ROW EXECUTE FUNCTION public.prevent_distribution_mutation();
    DROP TABLE public.member_payouts;
    ALTER TABLE public.cycle_distributions DROP CONSTRAINT distributions_payout_member_unique,
      DROP CONSTRAINT cycle_distributions_entitlement_check, DROP CONSTRAINT cycle_distributions_payment_check,
      ADD CONSTRAINT cycle_distributions_status_check CHECK(status='pending'),
      ADD CONSTRAINT cycle_distributions_check CHECK(${entitlementCheck} AND paid_amount=0);
    ALTER TABLE public.accounts DROP CONSTRAINT accounts_group_id_cycle_payout_unique;
  `);
};
