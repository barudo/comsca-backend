exports.up = async function up(knex) {
  await knex.schema.createTable("expense_payments", table => {
    table.bigInteger("group_id").notNullable();
    table.bigInteger("cycle_id").notNullable();
    table.bigInteger("expense_transaction_id").notNullable();
    table.bigInteger("payment_transaction_id").notNullable();
    table.decimal("amount", 18, 2).notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["group_id", "expense_transaction_id"]);
    for (const field of ["expense_transaction_id", "payment_transaction_id"]) {
      table.foreign(["group_id", field, "cycle_id"])
        .references(["group_id", "id", "cycle_id"]).inTable("transactions").onDelete("RESTRICT");
    }
    table.check("amount > 0 AND amount <> 'NaN'::numeric");
    table.check("expense_transaction_id <> payment_transaction_id");
    table.index(["group_id", "payment_transaction_id"]);
  });
  await knex.raw("ALTER TABLE public.expense_payments ENABLE ROW LEVEL SECURITY");
};

exports.down = async function down(knex) {
  // Payment links are audit records; do not silently discard them on rollback.
  await knex.raw(`LOCK TABLE public.expense_payments IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.expense_payments) THEN
        RAISE EXCEPTION 'Rollback would lose expense payment links' USING ERRCODE='23514';
      END IF;
    END $$;`);
  await knex.schema.dropTable("expense_payments");
};
