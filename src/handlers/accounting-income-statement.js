function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

class AccountingIncomeStatementHandler {
  async get(request, response, next) {
    const { from, to } = request.query ?? {};
    if (
      (from !== undefined && !isCalendarDate(from)) ||
      (to !== undefined && !isCalendarDate(to)) ||
      (from !== undefined && to !== undefined && from > to)
    ) {
      return response.status(400).json({
        success: false,
        error: "Dates must use YYYY-MM-DD and from must not be after to",
      });
    }

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
            new Error("A financial role in this group is required to view the income statement"),
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
                    CASE WHEN a.type = 'INCOME'
                      THEN -COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                      ELSE COALESCE(SUM(ae.amount) FILTER (WHERE t.id IS NOT NULL), 0.00)
                    END AS amount
                  FROM accounts a
                  LEFT JOIN account_entries ae
                    ON ae.account_id = a.id AND ae.group_id = a.group_id
                  LEFT JOIN transaction_entries e
                    ON e.id = ae.transaction_entry_id AND e.group_id = ae.group_id
                  LEFT JOIN transactions t
                    ON t.id = e.transaction_id AND t.group_id = e.group_id
                    AND t.cycle_id = a.cycle_id
                    ${from !== undefined ? "AND t.occurred_at >= (?::date::timestamp AT TIME ZONE 'Asia/Manila')" : ""}
                    ${to !== undefined ? "AND t.occurred_at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')" : ""}
                  WHERE a.group_id = ? AND a.cycle_id = ?
                    AND a.type IN ('INCOME', 'EXPENSE')
                  GROUP BY a.id
                ), section_totals AS (
                  SELECT
                    COALESCE(SUM(amount) FILTER (WHERE type = 'INCOME'), 0.00) AS total_income,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'EXPENSE'), 0.00) AS total_expenses
                  FROM account_balances
                )
                SELECT a.id, a.code, a.name, a.type, a.amount::text AS amount,
                  s.total_income::text AS total_income,
                  s.total_expenses::text AS total_expenses,
                  (s.total_income - s.total_expenses)::text AS net_income
                FROM account_balances a
                CROSS JOIN section_totals s
                ORDER BY a.code, a.id
                `,
                [
                  ...(from !== undefined ? [from] : []),
                  ...(to !== undefined ? [to] : []),
                  groupId,
                  cycle.id,
                ],
              )
            ).rows
          : [];

        const totals = rows.length
          ? {
              total_income: rows[0].total_income,
              total_expenses: rows[0].total_expenses,
              net_income: rows[0].net_income,
            }
          : {
              total_income: "0.00",
              total_expenses: "0.00",
              net_income: "0.00",
            };
        const accountsFor = (type) =>
          rows
            .filter((row) => row.type === type)
            .map(({ id, code, name, amount }) => ({ id, code, name, amount }));

        return {
          success: true,
          current_cycle_id: cycle?.id ?? null,
          income: {
            accounts: accountsFor("INCOME"),
            total: totals.total_income,
          },
          expenses: {
            accounts: accountsFor("EXPENSE"),
            total: totals.total_expenses,
          },
          ...totals,
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

module.exports = AccountingIncomeStatementHandler;
