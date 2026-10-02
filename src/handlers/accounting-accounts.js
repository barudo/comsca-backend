const accountTypes = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

class AccountingAccountsHandler {
  async list(request, response, next) {
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
            new Error("A financial role in this group is required to view accounts"),
            { status: 403 },
          );
        }

        const cycle = await trx("cycles")
          .where({ group_id: groupId })
          .whereIn("status", ["active", "distributing"])
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .first("id");

        const accountRows = cycle
          ? (
              await trx.raw(
                `
                WITH account_balances AS (
                  SELECT a.id, a.code, a.name, a.type,
                    CASE WHEN a.type IN ('LIABILITY', 'EQUITY', 'INCOME')
                      THEN -COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                      ELSE COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                    END AS current_balance
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
                )
                SELECT id, code, name, type,
                  current_balance::text AS current_balance,
                  SUM(current_balance) OVER (PARTITION BY type)::text AS total_balance
                FROM account_balances
                ORDER BY type, code, id
                `,
                [groupId, cycle.id],
              )
            ).rows
          : [];

        const groupedAccounts = Object.fromEntries(
          accountTypes.map((type) => [
            type,
            { type, total_balance: "0.00", sub_accounts: [] },
          ]),
        );
        for (const row of accountRows) {
          const group = groupedAccounts[row.type];
          group.total_balance = row.total_balance;
          group.sub_accounts.push({
            id: row.id,
            code: row.code,
            name: row.name,
            current_balance: row.current_balance,
          });
        }

        return {
          success: true,
          current_cycle_id: cycle?.id ?? null,
          accounts: accountTypes.map((type) => groupedAccounts[type]),
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

module.exports = AccountingAccountsHandler;