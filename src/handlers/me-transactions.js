class MeTransactionsHandler {
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(
        async (trx) => {
          await trx.raw(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
          );
          const group_id = request.group.id;
          const user = await trx("users")
            .where({ auth_user_id: request.authUser.id, group_id })
            .first("id");
          if (!user) {
            throw Object.assign(
              new Error("You do not have a user profile in this group"),
              { status: 403 },
            );
          }

          const cycle = await trx("cycles")
            .where({ group_id })
            .whereIn("status", ["active", "distributing"])
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .first("id");
          if (!cycle) return { success: true, data: [] };

          const { rows: data } = await trx.raw(
            `
          SELECT e.id, e.group_id, e.transaction_id,
            COALESCE(e.user_id, t.user_id) AS user_id,
            COALESCE(e.cycle_id, t.cycle_id) AS cycle_id,
            e.type, e.amount::text AS amount, e.description,
            e.created_at, e.updated_at, t.occurred_at AS transaction_occurred_at
          FROM transaction_entries e
          JOIN transactions t ON t.id = e.transaction_id AND t.group_id = e.group_id
          WHERE e.group_id = ? AND t.group_id = ?
            AND t.status = 'active'
            AND COALESCE(e.user_id, t.user_id) = ? AND t.cycle_id = ?
          ORDER BY t.occurred_at ASC, t.id ASC, e.id ASC
        `,
            [group_id, group_id, user.id, cycle.id],
          );
          return { success: true, data };
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

module.exports = MeTransactionsHandler;
