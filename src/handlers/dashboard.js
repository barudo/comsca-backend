const zeroTotals = {
  cash_on_hand: "0.00",
  outstanding_loans: "0.00",
  total_fund_value: "0.00",
  share_capital: "0.00",
  contributions_collected: "0.00",
  contributions_due: "0.00",
  active_members: 0,
};

class DashboardHandler {
  async get(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(
        async (trx) => {
          await trx.raw(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
          );
          const group_id = request.group.id;
          const actor = await trx("users")
            .where({ auth_user_id: request.authUser.id, group_id })
            .first("id", "role");
          if (
            !actor ||
            !["OWNER", "ADMIN", "TREASURER", "AUDITOR"].includes(actor.role)
          ) {
            throw Object.assign(
              new Error(
                "A financial role in this group is required to view the dashboard",
              ),
              { status: 403 },
            );
          }

          const cycle = await trx("cycles")
            .where({ group_id })
            .whereIn("status", ["active", "distributing"])
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .first("id");
          if (!cycle) {
            return {
              success: true,
              current_cycle_id: null,
              ...zeroTotals,
            };
          }

          const { rows } = await trx.raw(
            `
          WITH scoped_accounts AS (
            SELECT a.id, a.code, a.type, COALESCE(SUM(ae.amount), 0.00) AS balance
            FROM accounts a
            LEFT JOIN account_entries ae
              ON ae.account_id = a.id AND ae.group_id = a.group_id
            WHERE a.group_id = ? AND a.cycle_id = ?
            GROUP BY a.id
          ), financial_totals AS (
            SELECT
              COALESCE(SUM(e.amount) FILTER (WHERE e.type IN ('LOAN_DISBURSED', 'LOAN_DISBURSEMENT', 'LOAN_INTEREST')), 0.00)
                - COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'LOAN_PAYMENT'), 0.00) AS outstanding_loans,
              COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'BUY_SHARE'), 0.00) AS share_capital,
              COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'PAY_CONTRIBUTION'), 0.00) AS contributions_collected,
              COALESCE(SUM(e.amount) FILTER (WHERE e.type IN ('CHARGE_CONTRIBUTION', 'CONTRIBUTION')), 0.00)
                - COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'PAY_CONTRIBUTION'), 0.00) AS contributions_due
            FROM transaction_entries e
            JOIN transactions t ON t.id = e.transaction_id AND t.group_id = e.group_id
            WHERE e.group_id = ? AND t.group_id = ? AND t.cycle_id = ?
          ), member_total AS (
            SELECT COUNT(*)::int AS active_members
            FROM cycle_members cm
            JOIN users u ON u.id = cm.user_id AND u.group_id = ?
            WHERE cm.cycle_id = ?
          )
          SELECT
            COALESCE((SELECT balance FROM scoped_accounts WHERE code = '1000'), 0.00)::text AS cash_on_hand,
            COALESCE((SELECT SUM(balance) FROM scoped_accounts WHERE type = 'ASSET'), 0.00)::text AS total_fund_value,
            financial_totals.outstanding_loans::text AS outstanding_loans,
            financial_totals.share_capital::text AS share_capital,
            financial_totals.contributions_collected::text AS contributions_collected,
            financial_totals.contributions_due::text AS contributions_due,
            member_total.active_members
          FROM financial_totals CROSS JOIN member_total
        `,
            [
              group_id,
              cycle.id,
              group_id,
              group_id,
              cycle.id,
              group_id,
              cycle.id,
            ],
          );
          return {
            success: true,
            current_cycle_id: cycle.id,
            ...rows[0],
          };
        },
      );
      return response.json(result);
    } catch (error) {
      if (error.status === 403) {
        return response.status(403).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }
}

module.exports = DashboardHandler;
