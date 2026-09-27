exports.up = async function up(knex) {
  await knex.schema.alterTable("transactions", table => {
    // Numeric sequence within the group/cycle and document type. Display prefixes
    // can be derived without duplicating the sequence or cycle identity.
    table.string("document_type", 32).nullable();
    table.bigInteger("document_number").nullable();
    table.check(`
      (document_type IS NULL AND document_number IS NULL) OR
      (document_type IS NOT NULL AND document_number IS NOT NULL
        AND document_type IN ('RECEIPT', 'DISBURSEMENT_VOUCHER', 'JOURNAL_VOUCHER')
        AND document_number > 0)
    `, [], "transactions_document_check");
  });
  await knex.raw(`CREATE UNIQUE INDEX transactions_cycle_document_unique
    ON public.transactions (group_id, cycle_id, document_type, document_number)
    WHERE cycle_id IS NOT NULL AND document_type IS NOT NULL`);
  // PostgreSQL normally treats NULLs as distinct; a separate index protects
  // group-level documents that have no cycle as well.
  await knex.raw(`CREATE UNIQUE INDEX transactions_group_document_unique
    ON public.transactions (group_id, document_type, document_number)
    WHERE cycle_id IS NULL AND document_type IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX public.transactions_group_document_unique");
  await knex.raw("DROP INDEX public.transactions_cycle_document_unique");
  await knex.schema.alterTable("transactions", table => {
    table.dropChecks("transactions_document_check");
    table.dropColumns("document_type", "document_number");
  });
};
