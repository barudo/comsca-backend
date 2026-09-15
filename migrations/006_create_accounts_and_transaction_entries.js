exports.up = async function up(knex) {
  await knex.schema.alterTable("transactions", (table) => {
    table.unique(["group_id", "id"], "transactions_group_id_id_unique");
  });
  await knex.schema.createTable("accounts", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("group_id").notNullable()
      .references("id").inTable("groups").onDelete("RESTRICT");
    table.string("code", 64).notNullable();
    table.string("name", 255).notNullable();
    table.string("type", 16).notNullable();
    table.text("description");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["group_id", "code"], "accounts_group_code_unique");
    table.unique(["group_id", "id"], "accounts_group_id_id_unique");
    table.check("type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')", [], "accounts_type_check");
    table.check("length(btrim(code)) > 0 AND length(btrim(name)) > 0", [], "accounts_labels_check");
  });
  await knex.schema.createTable("transaction_entries", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("group_id").notNullable();
    table.bigInteger("transaction_id").notNullable();
    table.bigInteger("account_id").notNullable();
    table.decimal("debit", 18, 2).notNullable().defaultTo(0);
    table.decimal("credit", 18, 2).notNullable().defaultTo(0);
    table.text("description");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.foreign(["group_id", "transaction_id"], "transaction_entries_group_transaction_fk")
      .references(["group_id", "id"]).inTable("transactions").onDelete("RESTRICT");
    table.foreign(["group_id", "account_id"], "transaction_entries_group_account_fk")
      .references(["group_id", "id"]).inTable("accounts").onDelete("RESTRICT");
    table.check(`debit <> 'NaN'::numeric AND credit <> 'NaN'::numeric AND
      ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))`, [], "transaction_entries_one_side_check");
    table.index(["transaction_id"], "transaction_entries_transaction_idx");
    table.index(["group_id", "account_id"], "transaction_entries_group_account_idx");
  });

  // Write the parent row to serialize concurrent entry changes. At stricter
  // isolation levels, competing changes fail with a serialization error.
  await knex.raw(`CREATE FUNCTION public.touch_accounting_transaction()
    RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND
        (OLD.transaction_id <> NEW.transaction_id OR OLD.group_id <> NEW.group_id) THEN
        RAISE EXCEPTION 'Entry transaction and group cannot be changed' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN
        UPDATE public.transactions SET updated_at = clock_timestamp() WHERE id = OLD.transaction_id;
        RETURN OLD;
      END IF;
      UPDATE public.transactions SET updated_at = clock_timestamp() WHERE id = NEW.transaction_id;
      RETURN NEW;
    END;
    $$`);
  await knex.raw(`CREATE TRIGGER transaction_entries_touch_parent
    BEFORE INSERT OR UPDATE OR DELETE ON public.transaction_entries
    FOR EACH ROW EXECUTE FUNCTION public.touch_accounting_transaction()`);

  // Entry writes update the parent, so this also checks edits and deletions.
  // Deferral permits inserting the header and individual lines in any order
  // after the header exists, provided they balance when the DB transaction ends.
  await knex.raw(`CREATE FUNCTION public.check_accounting_transaction_balance()
    RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
    DECLARE
      entry_count bigint;
      debit_total numeric;
      credit_total numeric;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE id = NEW.id) THEN
        RETURN NULL;
      END IF;
      SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
        INTO entry_count, debit_total, credit_total
        FROM public.transaction_entries WHERE transaction_id = NEW.id;
      IF entry_count < 2 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'Transaction % requires at least two balanced accounting entries', NEW.id
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$`);
  await knex.raw(`CREATE CONSTRAINT TRIGGER transactions_balanced_entries
    AFTER INSERT OR UPDATE ON public.transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.check_accounting_transaction_balance()`);
  for (const table of ["accounts", "transaction_entries"]) {
    await knex.raw("ALTER TABLE ?? ENABLE ROW LEVEL SECURITY", [table]);
  }
};

exports.down = async function down(knex) {
  await knex.raw("DROP TRIGGER IF EXISTS transactions_balanced_entries ON public.transactions");
  await knex.schema.dropTableIfExists("transaction_entries");
  await knex.raw("DROP FUNCTION IF EXISTS public.check_accounting_transaction_balance()");
  await knex.raw("DROP FUNCTION IF EXISTS public.touch_accounting_transaction()");
  await knex.schema.dropTableIfExists("accounts");
  await knex.schema.alterTable("transactions", (table) => {
    table.dropUnique(["group_id", "id"], "transactions_group_id_id_unique");
  });
};
