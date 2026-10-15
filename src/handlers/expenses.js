const GroupAccountTransactionsHandler = require("./group-account-transactions");

class ExpensesHandler extends GroupAccountTransactionsHandler {
  async list(request, response, next) {
    try {
      const data = await request.app.locals.database.transaction(async trx => {
        await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const group_id = request.group.id;
        const user = await trx("users")
          .where({ auth_user_id: request.authUser.id, group_id })
          .first("id");
        if (!user) {
          throw Object.assign(new Error("You do not have a user profile in this group"), { status: 403 });
        }
        return trx("transactions")
          .where({ group_id, type: "EXPENSE" })
          .orderBy("occurred_at", "desc")
          .orderBy("id", "desc")
          .select("*");
      });
      return response.json({ success: true, data });
    } catch (error) {
      if (error.status === 403) {
        return response.status(403).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }

  constructor() {
    super({
      type: "EXPENSE",
      label: "expense",
      journalVoucher: true,
      extraFields: [],
      requireDescription: true,
      validateAccounts(debit, credit, fail) {
        if (debit.type !== "EXPENSE") fail("Debit must be an EXPENSE account");
        if (credit.type !== "LIABILITY") fail("Credit must be a LIABILITY account");
      },
    });
  }
}

module.exports = ExpensesHandler;
