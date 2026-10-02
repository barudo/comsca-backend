class AccountingTrialBalanceHandler {
  async get(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async (trx) => {
        await trx.raw(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const groupId = request.group.id;
        const actor = await trx("users")
          .where({ auth_user_id: request.authUser.id, group_id: groupId })
          .first("id", "role");
        if (
          !actor ||
          !["OWNER", "ADMIN", "TREASURER", "AUDITOR"].includes(actor.role)
        ) {
          throw Object.assign(
            new Error("A financial role in this group is required to view the trial balance"),
            { status: 403 },
          );
        }

        const cycle = await trx("cycles")
          .where({ group_id: groupId })
          .whereIn("status", ["active", "distributing"])
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .first("id");

        const rows = cycle
          ? (
              await trx.raw(
                `
                WITH account_totals AS (
                  SELECT a.id, a.code, a.name, a.type,
                    COALESCE(SUM(ae.amount) FILTER (
                      WHERE t.id IS NOT NULL AND ae.amount > 0
                    ), 0.00) AS total_debits,
                    COALESCE(SUM(-ae.amount) FILTER (
                      WHERE t.id IS NOT NULL AND ae.amount < 0
                    ), 0.00) AS total_credits
                  FROM accounts a
                  LEFT JOIN account_entries ae
                    ON ae.account_id = a.id AND ae.group_id = a.group_id
                  LEFT JOIN transaction_entries e
                    ON e.id = ae.transaction_entry_id AND e.group_id = ae.group_id
                  LEFT JOIN transactions t
                    ON t.id = e.transaction_id AND t.group_id = e.group_id
                    AND t.cycle_id = a.cycle_id
                  WHERE a.group_id = ? AND a.cycle_id = ?
                  GROUP BY a.id
                ), account_balances AS (
                  SELECT id, code, name, type, total_debits, total_credits,
                    GREATEST(total_debits - total_credits, 0.00) AS debit_balance,
                    GREATEST(total_credits - total_debits, 0.00) AS credit_balance
                  FROM account_totals
                )
                SELECT id, code, name, type,
                  total_debits::text AS total_debits,
                  total_credits::text AS total_credits,
                  debit_balance::text AS debit_balance,
                  credit_balance::text AS credit_balance,
                  SUM(debit_balance) OVER ()::text AS summary_debits,
                  SUM(credit_balance) OVER ()::text AS summary_credits,
                  (SUM(debit_balance) OVER () - SUM(credit_balance) OVER ())::text AS difference
                FROM account_balances
                ORDER BY code, id
                `,
                [groupId, cycle.id],
              )
            ).rows
          : [];

        const summary = rows.length
          ? {
              total_debits: rows[0].summary_debits,
              total_credits: rows[0].summary_credits,
              difference: rows[0].difference,
            }
          : { total_debits: "0.00", total_credits: "0.00", difference: "0.00" };

        return {
          success: true,
          current_cycle_id: cycle?.id ?? null,
          accounts: rows.map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
            type: row.type,
            total_debits: row.total_debits,
            total_credits: row.total_credits,
            debit_balance: row.debit_balance,
            credit_balance: row.credit_balance,
          })),
          summary,
        };
      });
      return response.json(result);
    } catch (error) {
      if (error.status === 403) {
        return response.status(403).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }
}

module.exports = AccountingTrialBalanceHandler;