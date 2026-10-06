async function setDocumentCheck(knex, types) {
  await knex.schema.alterTable("transactions", table => {
    table.dropChecks("transactions_document_check");
    table.check(`
      (document_type IS NULL AND document_number IS NULL) OR
      (document_type IS NOT NULL AND document_number IS NOT NULL
        AND document_type IN (${types.map(type => "'" + type + "'").join(", ")})
        AND document_number > 0)
    `, [], "transactions_document_check");
  });
}

const existingTypes = ["RECEIPT", "DISBURSEMENT_VOUCHER", "JOURNAL_VOUCHER"];

exports.up = async function up(knex) {
  await setDocumentCheck(knex, [...existingTypes, "PAYMENT_RECEIPT"]);
};

exports.down = async function down(knex) {
  // Refuse rollback while payment receipts exist instead of rewriting issued documents.
  await setDocumentCheck(knex, existingTypes);
};
