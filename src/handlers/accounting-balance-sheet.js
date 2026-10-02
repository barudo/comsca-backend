class AccountingBalanceSheetHandler {
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
            new Error("A financial role in this group is required to view the balance sheet"),
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
                WITH account_balances AS (
                  SELECT a.id, a.code, a.name, a.type,
                    CASE WHEN a.type IN ('LIABILITY', 'EQUITY', 'INCOME')
                      THEN -COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                      ELSE COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                    END AS balance
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
                ), section_totals AS (
                  SELECT *,
                    COALESCE(SUM(balance) FILTER (WHERE type = 'ASSET') OVER (), 0.00) AS total_assets,
                    COALESCE(SUM(balance) FILTER (WHERE type = 'LIABILITY') OVER (), 0.00) AS total_liabilities,
                    COALESCE(SUM(balance) FILTER (WHERE type = 'EQUITY') OVER (), 0.00) AS equity_accounts_total,
                    COALESCE(SUM(balance) FILTER (WHERE type = 'INCOME') OVER (), 0.00) AS income_total,
                    COALESCE(SUM(balance) FILTER (WHERE type = 'EXPENSE') OVER (), 0.00) AS expense_total
                  FROM account_balances
                )
                SELECT id, code, name, type, balance::text AS balance,
                  total_assets::text AS total_assets,
                  total_liabilities::text AS total_liabilities,
                  equity_accounts_total::text AS equity_accounts_total,
                  income_total::text AS income_total,
                  expense_total::text AS expense_total,
                  (income_total - expense_total)::text AS current_earnings,
                  (equity_accounts_total + income_total - expense_total)::text AS total_equity,
                  (total_liabilities + equity_accounts_total + income_total - expense_total)::text
                    AS total_liabilities_and_equity,
                  (total_assets - total_liabilities - equity_accounts_total - income_total + expense_total)::text
                    AS difference
                FROM section_totals
                ORDER BY code, id
                `,
                [groupId, cycle.id],
              )
            ).rows
          : [];

        const totals = rows.length
          ? {
              total_assets: rows[0].total_assets,
              total_liabilities: rows[0].total_liabilities,
              total_equity: rows[0].total_equity,
              total_liabilities_and_equity: rows[0].total_liabilities_and_equity,
              difference: rows[0].difference,
              income_total: rows[0].income_total,
              expense_total: rows[0].expense_total,
              current_earnings: rows[0].current_earnings,
            }
          : {
              total_assets: "0.00",
              total_liabilities: "0.00",
              total_equity: "0.00",
              total_liabilities_and_equity: "0.00",
              difference: "0.00",
              income_total: "0.00",
              expense_total: "0.00",
              current_earnings: "0.00",
            };
        const accountsFor = (type) =>
          rows
            .filter((row) => row.type === type)
            .map(({ id, code, name, balance }) => ({ id, code, name, balance }));

        return {
          success: true,
          current_cycle_id: cycle?.id ?? null,
          assets: {
            accounts: accountsFor("ASSET"),
            total: totals.total_assets,
          },
          liabilities: {
            accounts: accountsFor("LIABILITY"),
            total: totals.total_liabilities,
          },
          equity: {
            accounts: accountsFor("EQUITY"),
            current_earnings: {
              income: totals.income_total,
              expenses: totals.expense_total,
              balance: totals.current_earnings,
            },
            total: totals.total_equity,
          },
          total_assets: totals.total_assets,
          total_liabilities: totals.total_liabilities,
          total_equity: totals.total_equity,
          total_liabilities_and_equity: totals.total_liabilities_and_equity,
          difference: totals.difference,
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

module.exports = AccountingBalanceSheetHandler;