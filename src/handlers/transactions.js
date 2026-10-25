function fail(message, status) {
  throw Object.assign(new Error(message), { status });
}

class TransactionsHandler {
  async void(request, response, next) {
    try {
      const transaction = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
          fail("Only an OWNER or ADMIN of this group can void transactions", 403);
        }
        const id = request.params.transactionId;
        if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
          fail("transactionId must be a positive bigint ID", 400);
        }
        const scope = await trx("transactions").where({ group_id, id }).first("cycle_id");
        if (!scope) fail("Transaction not found", 404);
        // Match expense-payment lock ordering before locking the header.
        if (scope.cycle_id !== null) {
          const cycle = await trx("cycles").where({ group_id, id: scope.cycle_id }).forUpdate().first("id", "status");
          if (cycle && ["distributing", "closed"].includes(cycle.status)) fail("Transactions in a distributing or closed cycle are read-only", 409);
        }
        const header = await trx("transactions").where({ group_id, id }).forUpdate().first("*");
        if (!header) fail("Transaction not found", 404);
        if (header.cycle_id !== scope.cycle_id) fail("Transaction cycle changed; refresh and retry", 409);
        if (header.status === "voided") return header;
        if (header.type === "EXPENSE" && header.expense_payment_status === "PAID") {
          fail("Paid expenses cannot be voided", 409);
        }
        const link = await trx("expense_payments").where({ group_id }).where(function () {
          this.where({ expense_transaction_id: id }).orWhere({ payment_transaction_id: id });
        }).first("expense_transaction_id");
        if (link) fail("Transactions linked to expense payments cannot be voided", 409);
        // Negate in PostgreSQL, without converting numeric values through JavaScript numbers.
        await trx.raw(`INSERT INTO account_entries
          (group_id, transaction_entry_id, account_id, amount, reversal_of_id)
          SELECT p.group_id, p.transaction_entry_id, p.account_id, -p.amount, p.id
          FROM account_entries p JOIN transaction_entries e
            ON e.id=p.transaction_entry_id AND e.group_id=p.group_id
          WHERE p.group_id=? AND e.group_id=? AND e.transaction_id=? AND p.reversal_of_id IS NULL`,
        [group_id, group_id, id]);
        const [result] = await trx("transactions").where({ group_id, id })
          .update({ status: "voided", updated_at: trx.fn.now() }).returning("*");
        return result;
      });
      return response.json({ success: true, transaction });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      if (["22003", "23001", "23503", "23505", "23514", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Transaction could not be voided; refresh and retry" });
      }
      return next(error);
    }
  }
}
module.exports = TransactionsHandler;
