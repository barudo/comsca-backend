// Keep the old schema builder for a lossless, explicitly guarded rollback.
const legacy = require('./006_create_accounts_and_transaction_entries');
exports.up = async function up(knex) {
  await knex.raw(`LOCK TABLE public.transactions, public.transaction_entries, public.accounts IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.transactions t LEFT JOIN public.transaction_entries e ON e.transaction_id=t.id
        GROUP BY t.id HAVING count(e.id)<2 OR COALESCE(sum(e.debit),0)<>t.amount OR COALESCE(sum(e.credit),0)<>t.amount)
      THEN RAISE EXCEPTION 'Legacy header/ledger mismatch: conversion aborted' USING ERRCODE='23514'; END IF;
    END $$;
    DROP TRIGGER transactions_balanced_entries ON public.transactions;
    DROP TRIGGER transaction_entries_touch_parent ON public.transaction_entries;
    ALTER TABLE public.accounts DROP CONSTRAINT accounts_group_code_unique;
    ALTER TABLE public.accounts ADD COLUMN cycle_id bigint;
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_group_cycle_fk FOREIGN KEY(group_id,cycle_id) REFERENCES public.cycles(group_id,id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX accounts_group_code_unique ON public.accounts(group_id,code) WHERE cycle_id IS NULL;
    CREATE UNIQUE INDEX accounts_cycle_code_unique ON public.accounts(group_id,cycle_id,code) WHERE cycle_id IS NOT NULL;
    INSERT INTO public.accounts(group_id,cycle_id,code,name,type,description,created_at,updated_at)
      SELECT DISTINCT a.group_id,t.cycle_id,a.code,a.name,a.type,a.description,a.created_at,a.updated_at
      FROM public.accounts a JOIN public.transaction_entries e ON e.account_id=a.id JOIN public.transactions t ON t.id=e.transaction_id WHERE t.cycle_id IS NOT NULL;
    UPDATE public.transaction_entries e SET account_id=a.id FROM public.transactions t, public.accounts old, public.accounts a
      WHERE t.id=e.transaction_id AND old.id=e.account_id AND a.group_id=t.group_id AND a.cycle_id=t.cycle_id AND a.code=old.code;
    ALTER TABLE public.transaction_entries RENAME TO legacy_postings;
    CREATE TABLE public.transaction_entries (
      id bigserial PRIMARY KEY, group_id bigint NOT NULL, transaction_id bigint NOT NULL,
      type varchar(64) NOT NULL CHECK(type ~ '^[A-Z][A-Z0-9_]*$'),
      amount numeric(18,2) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric), description text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(group_id,id), FOREIGN KEY(group_id,transaction_id) REFERENCES public.transactions(group_id,id) ON DELETE RESTRICT);
    CREATE INDEX components_transaction_idx ON public.transaction_entries(transaction_id);
    INSERT INTO public.transaction_entries(group_id,transaction_id,type,amount,description,created_at,updated_at)
      SELECT group_id,id,type,amount,description,created_at,updated_at FROM public.transactions;
    CREATE TABLE public.account_entries (
      id bigserial PRIMARY KEY, group_id bigint NOT NULL, transaction_entry_id bigint NOT NULL, account_id bigint NOT NULL,
      amount numeric(18,2) NOT NULL CHECK(amount<>0 AND amount<>'NaN'::numeric), description text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(group_id,transaction_entry_id) REFERENCES public.transaction_entries(group_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id,account_id) REFERENCES public.accounts(group_id,id) ON DELETE RESTRICT);
    CREATE INDEX account_entries_component_idx ON public.account_entries(transaction_entry_id);
    CREATE INDEX account_entries_account_idx ON public.account_entries(group_id,account_id);
    INSERT INTO public.account_entries(id,group_id,transaction_entry_id,account_id,amount,description,created_at,updated_at)
      SELECT e.id,e.group_id,c.id,e.account_id,e.debit-e.credit,e.description,e.created_at,e.updated_at
      FROM public.legacy_postings e JOIN public.transaction_entries c ON c.transaction_id=e.transaction_id;
    SELECT setval(pg_get_serial_sequence('public.account_entries','id'),COALESCE(max(id),1),count(*)>0) FROM public.account_entries;
    DROP TABLE public.legacy_postings;
    ALTER TABLE public.transaction_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.account_entries ENABLE ROW LEVEL SECURITY;
    CREATE TRIGGER transaction_entries_touch_parent BEFORE INSERT OR UPDATE OR DELETE ON public.transaction_entries
      FOR EACH ROW EXECUTE FUNCTION public.touch_accounting_transaction();
    CREATE FUNCTION public.touch_posting_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    DECLARE component bigint;
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.transaction_entry_id<>NEW.transaction_entry_id OR OLD.group_id<>NEW.group_id) THEN
        RAISE EXCEPTION 'Posting component and group cannot be changed' USING ERRCODE='23514'; END IF;
      IF TG_OP='DELETE' THEN component:=OLD.transaction_entry_id; ELSE component:=NEW.transaction_entry_id; END IF;
      UPDATE public.transactions SET updated_at=clock_timestamp() WHERE id=(SELECT transaction_id FROM public.transaction_entries WHERE id=component);
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER account_entries_touch_parent BEFORE INSERT OR UPDATE OR DELETE ON public.account_entries
      FOR EACH ROW EXECUTE FUNCTION public.touch_posting_transaction();
    CREATE FUNCTION public.prevent_account_scope_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN
      IF OLD.group_id<>NEW.group_id OR OLD.cycle_id IS DISTINCT FROM NEW.cycle_id THEN
        RAISE EXCEPTION 'Account group and cycle cannot be changed' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER accounts_immutable_scope BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.prevent_account_scope_change();
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
    CREATE CONSTRAINT TRIGGER transactions_balanced_entries AFTER INSERT OR UPDATE ON public.transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_accounting_transaction_balance();`);
};

exports.down = async function down(knex) {
  await knex.raw(`LOCK TABLE public.transactions, public.transaction_entries, public.account_entries, public.accounts IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM public.accounts WHERE cycle_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Rollback would lose account cycle ownership; restore a backup or retain this migration'; END IF;
      IF EXISTS(SELECT 1 FROM public.transactions t LEFT JOIN public.transaction_entries c ON c.transaction_id=t.id
        GROUP BY t.id HAVING count(c.id)<>1 OR bool_or(c.type<>t.type OR c.amount<>t.amount OR c.description IS DISTINCT FROM t.description
        OR c.created_at<>t.created_at OR c.updated_at<>t.updated_at)) THEN
        RAISE EXCEPTION 'Rollback would lose business component data'; END IF;
    END $$;
    CREATE TEMP TABLE rollback_accounts ON COMMIT DROP AS SELECT * FROM public.accounts;
    CREATE TEMP TABLE rollback_postings ON COMMIT DROP AS SELECT p.id,p.group_id,c.transaction_id,p.account_id,
      GREATEST(p.amount,0) AS debit,GREATEST(-p.amount,0) AS credit,p.description,p.created_at,p.updated_at
      FROM public.account_entries p JOIN public.transaction_entries c ON c.id=p.transaction_entry_id;
    DROP TABLE public.account_entries;
    DROP TRIGGER accounts_immutable_scope ON public.accounts;
    DROP FUNCTION public.prevent_account_scope_change();
    DROP FUNCTION public.touch_posting_transaction();`);
  await legacy.down(knex);
  await legacy.up(knex);
  await knex.raw(`INSERT INTO public.accounts(id,group_id,code,name,type,description,created_at,updated_at)
    SELECT id,group_id,code,name,type,description,created_at,updated_at FROM rollback_accounts;
    ALTER TABLE public.transaction_entries DISABLE TRIGGER transaction_entries_touch_parent;
    INSERT INTO public.transaction_entries SELECT * FROM rollback_postings;
    ALTER TABLE public.transaction_entries ENABLE TRIGGER transaction_entries_touch_parent;
    SELECT setval(pg_get_serial_sequence('public.accounts','id'),COALESCE(max(id),1),count(*)>0) FROM public.accounts;
    SELECT setval(pg_get_serial_sequence('public.transaction_entries','id'),COALESCE(max(id),1),count(*)>0) FROM public.transaction_entries;`);
};
