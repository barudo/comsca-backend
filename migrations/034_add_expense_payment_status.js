exports.up = async function up(knex) {
  await knex.schema.alterTable("transactions", table => {
    // Existing expenses remain unknown until reconciled. A table-wide default
    // would incorrectly mark non-expense transactions as unpaid.
    table.string("expense_payment_status", 16).nullable();
    table.check(
      "expense_payment_status IS NULL OR (type = 'EXPENSE' AND expense_payment_status IN ('UNPAID', 'PAID'))",
      [],
      "transactions_expense_payment_status_check",
    );
  });
  await knex.raw(`
    CREATE FUNCTION public.default_expense_payment_status()
    RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      IF NEW.type = 'EXPENSE' AND NEW.expense_payment_status IS NULL THEN
        NEW.expense_payment_status := 'UNPAID';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER transactions_default_expense_payment_status
      BEFORE INSERT ON public.transactions
      FOR EACH ROW EXECUTE FUNCTION public.default_expense_payment_status();
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP TRIGGER transactions_default_expense_payment_status ON public.transactions;
    DROP FUNCTION public.default_expense_payment_status();
  `);
  await knex.schema.alterTable("transactions", table => {
    table.dropChecks("transactions_expense_payment_status_check");
    table.dropColumn("expense_payment_status");
  });
};
