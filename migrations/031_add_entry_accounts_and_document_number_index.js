exports.up = async function up(knex) {
  await knex.schema.alterTable("transaction_entries", table => {
    // Nullable for legacy components with multiple debit or credit accounts.
    table.bigInteger("debit").nullable();
    table.bigInteger("credit").nullable();
    for (const side of ["debit", "credit"]) {
      table.foreign(["group_id", side], `transaction_entries_group_${side}_fk`)
        .references(["group_id", "id"]).inTable("accounts").onDelete("RESTRICT");
    }
  });

  // Create the index before the backfill touches parent transactions and queues
  // deferred balance checks; PostgreSQL blocks DDL with pending trigger events.
  await knex.schema.alterTable("transactions", table => {
    table.index(["document_number"], "transactions_document_number_idx");
  });

  // Only infer a pair when each side identifies exactly one account.
  await knex.raw(`
    UPDATE public.transaction_entries AS e
    SET debit = p.debit, credit = p.credit
    FROM (
      SELECT group_id, transaction_entry_id,
        min(account_id) FILTER (WHERE amount > 0) AS debit,
        min(account_id) FILTER (WHERE amount < 0) AS credit
      FROM public.account_entries
      GROUP BY group_id, transaction_entry_id
      HAVING count(DISTINCT account_id) FILTER (WHERE amount > 0) = 1
         AND count(DISTINCT account_id) FILTER (WHERE amount < 0) = 1
    ) AS p
    WHERE e.group_id = p.group_id AND e.id = p.transaction_entry_id
  `);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("transactions", table => {
    table.dropIndex(["document_number"], "transactions_document_number_idx");
  });
  await knex.schema.alterTable("transaction_entries", table => {
    for (const side of ["debit", "credit"]) {
      table.dropForeign(["group_id", side], `transaction_entries_group_${side}_fk`);
    }
    table.dropColumns("debit", "credit");
  });
};
