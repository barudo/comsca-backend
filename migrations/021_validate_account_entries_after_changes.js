async function replaceTriggers(knex, timing) {
  // Header validation must see the child change even when the caller explicitly
  // switches deferred constraints to IMMEDIATE. Parent writes still serialize
  // competing changes before either statement can finish.
  await knex.raw(`
    DROP TRIGGER transaction_entries_touch_parent ON public.transaction_entries;
    CREATE TRIGGER transaction_entries_touch_parent ${timing} INSERT OR UPDATE OR DELETE
      ON public.transaction_entries FOR EACH ROW
      EXECUTE FUNCTION public.touch_accounting_transaction();
    DROP TRIGGER account_entries_touch_parent ON public.account_entries;
    CREATE TRIGGER account_entries_touch_parent ${timing} INSERT OR UPDATE OR DELETE
      ON public.account_entries FOR EACH ROW
      EXECUTE FUNCTION public.touch_posting_transaction();
  `);
}

exports.up = knex => replaceTriggers(knex, "AFTER");
exports.down = knex => replaceTriggers(knex, "BEFORE");
