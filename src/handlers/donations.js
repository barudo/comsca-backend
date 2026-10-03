const GroupAccountTransactionsHandler = require("./group-account-transactions");

class DonationsHandler extends GroupAccountTransactionsHandler {
  constructor() {
    super({
      type: "DONATION",
      label: "donation",
      extraFields: ["date", "remarks"],
      requireDescription: false,
      validateAccounts(debit, credit, fail) {
        if (debit.type !== "ASSET") fail("Debit must be an ASSET account");
        if (credit.type !== "INCOME" || credit.code !== "4300") {
          fail("Credit must be Donation Income (4300), an INCOME account");
        }
      },
    });
  }
}

module.exports = DonationsHandler;
