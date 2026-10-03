const GroupAccountTransactionsHandler = require("./group-account-transactions");

class ExpensesHandler extends GroupAccountTransactionsHandler {
  constructor() {
    super({
      type: "EXPENSE",
      label: "expense",
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
