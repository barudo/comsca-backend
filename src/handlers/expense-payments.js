function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function record(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) fail("Invalid expense payment fields");
}

function id(value) {
  if (!["string", "number"].includes(typeof value) ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) {
    fail("Expense and account IDs must be valid positive IDs");
  }
  return String(value);
}

function cents(value) {
  if (!["string", "number"].includes(typeof value) ||
      (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000))) {
    fail("Use positive decimal amounts; send large amounts as strings");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) fail("Amounts must be positive with at most two decimal places");
  const result = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  if (result <= 0n || result > 999999999999999999n) fail("Amount must fit numeric(18,2)");
  return result;
}

function decimal(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function parse(body) {
  record(body, ["expenses", "debit", "credit"]);
  const debit = id(body.debit), credit = id(body.credit);
  if (debit === credit) fail("Debit and credit must use different accounts");
  if (!Array.isArray(body.expenses) || body.expenses.length < 1 || body.expenses.length > 100) {
    fail("Provide between 1 and 100 expenses");
  }
  const expenses = body.expenses.map(item => {
    record(item, ["id", "amount"]);
    return { id: id(item.id), cents: cents(item.amount) };
  });
  if (new Set(expenses.map(item => item.id)).size !== expenses.length) fail("Duplicate expense IDs are not allowed");
  const total = expenses.reduce((sum, item) => sum + item.cents, 0n);
  if (total > 999999999999999999n) fail("Total payment must fit numeric(18,2)");
  return { debit, credit, expenses, amount: decimal(total) };
}

class ExpensePaymentsHandler {
  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER"].includes(actor.role)) {
          fail("Only an OWNER, ADMIN or TREASURER of this group can pay expenses", 403);
        }
        const input = parse(request.body);
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["active"])
          .orderBy("created_at", "desc").orderBy("id", "desc").forUpdate().first("id");
        if (!cycle) fail("This group has no writable current cycle", 409);
        const ids = input.expenses.map(item => item.id);
        const expenses = await trx("transactions").where({ group_id, cycle_id: cycle.id, type: "EXPENSE" })
          .whereIn("id", ids).orderBy("id").forUpdate().select("*");
        if (expenses.length !== ids.length) fail("Selected expenses were not found in the current group and cycle", 404);
        for (const expense of expenses) {
          if (expense.status !== "active" || expense.expense_payment_status !== "UNPAID") {
            fail("Every expense must be active and UNPAID; reconcile unknown statuses before payment", 409);
          }
          const submitted = input.expenses.find(item => item.id === String(expense.id));
          if (cents(expense.amount) !== submitted.cents) fail("Each amount must equal the full stored expense amount", 409);
        }
        const prior = await trx("expense_payments").where({ group_id }).whereIn("expense_transaction_id", ids).first("expense_transaction_id");
        if (prior) fail("An expense already has a recorded payment", 409);
        const accounts = await trx("accounts").where({ group_id }).whereIn("id", [input.debit, input.credit])
          .orderBy("id").forShare().select("id", "cycle_id", "type");
        const debit = accounts.find(account => String(account.id) === input.debit);
        const credit = accounts.find(account => String(account.id) === input.credit);
        if (!debit || !credit) fail("Selected accounts were not found in this group", 404);
        if (accounts.some(account => String(account.cycle_id) !== String(cycle.id))) fail("Selected accounts must belong to the current cycle");
        if (debit.type !== "LIABILITY" || credit.type !== "ASSET") fail("Debit must be a LIABILITY payable account and credit must be an ASSET funding account");
        const postings = await trx("account_entries as p")
          .join("transaction_entries as e", function () {
            this.on("e.id", "=", "p.transaction_entry_id").andOn("e.group_id", "=", "p.group_id");
          })
          .where({ "p.group_id": group_id }).whereIn("e.transaction_id", ids)
          .where("p.amount", "<", 0).select("e.transaction_id", "p.account_id", "p.amount");
        for (const expense of expenses) {
          const credits = postings.filter(posting => String(posting.transaction_id) === String(expense.id));
          if (!credits.length || credits.some(posting => String(posting.account_id) !== input.debit) ||
              credits.reduce((sum, posting) => sum + cents(String(posting.amount).slice(1)), 0n) !== cents(expense.amount)) {
            fail("Debit must match the full original payable account of every expense", 409);
          }
        }
        // The current-cycle lock serializes funding checks with other cycle payments.
        const { rows: [funding] } = await trx.raw(
          "SELECT COALESCE(SUM(amount), 0) >= ?::numeric AS sufficient FROM account_entries WHERE group_id = ? AND account_id = ?",
          [input.amount, group_id, input.credit],
        );
        if (!funding.sufficient) fail("Insufficient balance in the selected funding account", 409);
        const [voucher] = await trx("cycles").where({ id: cycle.id, group_id })
          .increment("disbursement_voucher_counter", 1).returning("disbursement_voucher_counter");
        const [header] = await trx("transactions").insert({
          group_id, cycle_id: cycle.id, user_id: null, type: "EXPENSE_PAYMENT", amount: input.amount,
          document_type: "DISBURSEMENT_VOUCHER", document_number: voucher.disbursement_voucher_counter,
        }).returning("id");
        const entries = await trx("transaction_entries").insert({
          group_id, transaction_id: header.id, cycle_id: cycle.id, user_id: null,
          type: "EXPENSE_PAYMENT", debit: input.debit, credit: input.credit, amount: input.amount,
        }).returning("*");
        const account_entries = await trx("account_entries").insert([
          { group_id, transaction_entry_id: entries[0].id, account_id: input.debit, amount: input.amount },
          { group_id, transaction_entry_id: entries[0].id, account_id: input.credit, amount: `-${input.amount}` },
        ]).returning("*");
        const expense_payments = await trx("expense_payments").insert(expenses.map(expense => ({
          group_id, cycle_id: cycle.id, expense_transaction_id: expense.id,
          payment_transaction_id: header.id, amount: expense.amount,
        }))).returning("*");
        await trx("transactions").where({ group_id, cycle_id: cycle.id, type: "EXPENSE", expense_payment_status: "UNPAID" })
          .whereIn("id", ids).update({ expense_payment_status: "PAID", updated_at: trx.fn.now() });
        const transaction = await trx("transactions").where({ id: header.id, group_id }).first("*");
        return { transaction, entries, account_entries, expense_payments };
      });
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      if (["22003", "23001", "23503", "23505", "23514", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Expense payment could not be committed; refresh and retry" });
      }
      return next(error);
    }
  }
}
module.exports = ExpensePaymentsHandler;
