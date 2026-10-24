exports.up = async function up(knex) {
  await knex.raw(`
    LOCK TABLE public.transactions, public.transaction_entries, public.account_entries IN ACCESS EXCLUSIVE MODE;
    ALTER TABLE public.account_entries ADD COLUMN reversal_of_id bigint;
    ALTER TABLE public.account_entries ADD CONSTRAINT account_entries_reversal_unique UNIQUE(reversal_of_id);
    ALTER TABLE public.account_entries ADD CONSTRAINT account_entries_reversal_fk
      FOREIGN KEY(reversal_of_id) REFERENCES public.account_entries(id) ON DELETE RESTRICT;
    ALTER TABLE public.account_entries ADD CONSTRAINT account_entries_not_self_reversal CHECK(reversal_of_id<>id);
    CREATE OR REPLACE FUNCTION public.check_accounting_transaction_balance() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    DECLARE header public.transactions%ROWTYPE;
    BEGIN
      SELECT * INTO header FROM public.transactions WHERE id=NEW.id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF (SELECT COALESCE(sum(amount),0) FROM public.transaction_entries WHERE transaction_id=header.id)<>header.amount
        OR EXISTS (SELECT 1 FROM public.transaction_entries c LEFT JOIN public.account_entries p ON p.transaction_entry_id=c.id AND p.reversal_of_id IS NULL
          WHERE c.transaction_id=header.id GROUP BY c.id HAVING
          COALESCE(sum(p.amount) FILTER(WHERE p.amount>0),0)<>c.amount OR COALESCE(-sum(p.amount) FILTER(WHERE p.amount<0),0)<>c.amount)
        OR EXISTS (SELECT 1 FROM public.transaction_entries c JOIN public.account_entries p ON p.transaction_entry_id=c.id
          JOIN public.accounts a ON a.id=p.account_id WHERE c.transaction_id=header.id AND
          (c.group_id<>header.group_id OR p.group_id<>header.group_id OR a.group_id<>header.group_id OR (a.cycle_id IS NOT NULL AND a.cycle_id IS DISTINCT FROM header.cycle_id)))
        OR EXISTS (SELECT 1 FROM public.transaction_entries c JOIN public.account_entries p ON p.transaction_entry_id=c.id
          LEFT JOIN public.account_entries original ON original.id=p.reversal_of_id
          WHERE c.transaction_id=header.id AND p.reversal_of_id IS NOT NULL AND
            (header.status<>'voided' OR original.id IS NULL OR original.reversal_of_id IS NOT NULL
             OR original.group_id<>p.group_id OR original.transaction_entry_id<>p.transaction_entry_id
             OR original.account_id<>p.account_id OR original.amount<>-p.amount))
        OR (header.status='voided' AND EXISTS (
          SELECT 1 FROM public.transaction_entries c JOIN public.account_entries p ON p.transaction_entry_id=c.id
          LEFT JOIN public.account_entries reversal ON reversal.reversal_of_id=p.id
          WHERE c.transaction_id=header.id AND p.reversal_of_id IS NULL AND reversal.id IS NULL))
      THEN RAISE EXCEPTION 'Transaction % component totals, postings or scope invalid',header.id USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END $$;

    -- Validate preexisting voided headers too: a status alone is not a reversal.
    UPDATE public.transactions SET updated_at=updated_at WHERE status='voided';
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    LOCK TABLE public.transactions, public.transaction_entries, public.account_entries IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM public.account_entries WHERE reversal_of_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM public.transactions WHERE status='voided') THEN
        RAISE EXCEPTION 'Rollback would lose transaction reversals' USING ERRCODE='23514';
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION public.check_accounting_transaction_balance() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    DECLARE header public.transactions%ROWTYPE;
    BEGIN
      SELECT * INTO header FROM public.transactions WHERE id=NEW.id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF (SELECT COALESCE(sum(amount),0) FROM public.transaction_entries WHERE transaction_id=header.id)<>header.amount
        OR EXISTS (SELECT 1 FROM public.transaction_entries c LEFT JOIN public.account_entries p ON p.transaction_entry_id=c.id
          WHERE c.transaction_id=header.id GROUP BY c.id HAVING
          COALESCE(sum(p.amount) FILTER(WHERE p.amount>0),0)<>c.amount OR COALESCE(-sum(p.amount) FILTER(WHERE p.amount<0),0)<>c.amount)
        OR EXISTS (SELECT 1 FROM public.transaction_entries c JOIN public.account_entries p ON p.transaction_entry_id=c.id
          JOIN public.accounts a ON a.id=p.account_id WHERE c.transaction_id=header.id AND
          (c.group_id<>header.group_id OR p.group_id<>header.group_id OR a.group_id<>header.group_id OR (a.cycle_id IS NOT NULL AND a.cycle_id IS DISTINCT FROM header.cycle_id)))
      THEN RAISE EXCEPTION 'Transaction % component totals, postings or scope invalid',header.id USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END $$;

    ALTER TABLE public.account_entries DROP COLUMN reversal_of_id;
  `);
};
