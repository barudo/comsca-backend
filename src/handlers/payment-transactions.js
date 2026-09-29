const transactionColumns = ["id", "group_id", "cycle_id", "user_id", "type", "amount",
  "description", "occurred_at", "created_at", "updated_at"];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

const creditRules = {
  PAY_CONTRIBUTION: account => account.type === "ASSET" && account.code === "1400",
  LOAN_PAYMENT: account => account.type === "ASSET" && account.code === "1100",
  BUY_SHARE: account => account.type === "EQUITY",
  PENALTY_PAYMENT: account => (account.type === "ASSET" && account.code === "1300") ||
    (account.type === "INCOME" && account.code === "4100"),
};

function record(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`Unsupported ${label} field`);
}

function id(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value))) fail(`${field} must be a positive ID`);
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) fail(`${field} must be a valid positive ID`);
  return text;
}

function description(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.includes("\u0000") || value.length > 4000) {
    fail("description must be a string of at most 4000 characters without null characters");
  }
  return value;
}

function decimal(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function paymentInput(body) {
  record(body, ["user_id", "cycle_id", "description", "entries"], "payment");
  const user_id = id(body.user_id, "user_id");
  const cycle_id = id(body.cycle_id, "cycle_id", true);
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 100) {
    fail("entries must contain between 1 and 100 payment entries");
  }
  let total = 0n;
  const entries = body.entries.map(entry => {
    record(entry, ["type", "debit", "credit", "amount", "description"], "payment entry");
    if (typeof entry.type !== "string" || !Object.hasOwn(creditRules, entry.type)) fail("Unsupported payment entry type");
    const debit = id(entry.debit, "debit");
    const credit = id(entry.credit, "credit");
    if (debit === credit) fail("Debit and credit must use different accounts");
    if (!["string", "number"].includes(typeof entry.amount)) fail("amount must be a positive decimal");
    if (typeof entry.amount === "number" && (!Number.isFinite(entry.amount) || Math.abs(entry.amount) > 1_000_000_000_000)) {
      fail("Send large amounts as decimal strings to preserve precision");
    }
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(entry.amount));
    if (!match) fail("amount must be positive with at most two decimal places");
    const whole = match[1].replace(/^0+/, "") || "0";
    const fraction = (match[2] || "").padEnd(2, "0");
    if (whole.length > 16) fail("amount must fit numeric(18,2)");
    const cents = BigInt(whole) * 100n + BigInt(fraction);
    if (cents === 0n) fail("amount must be greater than zero");
    total += cents;
    if (total > 999999999999999999n) fail("Payment total must fit numeric(18,2)");
    return { type: entry.type, debit, credit, amount: decimal(cents), description: description(entry.description) };
  });
  return { user_id, cycle_id, description: description(body.description), entries, amount: decimal(total) };
}

class PaymentTransactionsHandler {
  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER"].includes(actor.role)) {
          fail("Only an OWNER, ADMIN or TREASURER of this group can post payments", 403);
        }
        const input = paymentInput(request.body);
        const accountIds = [...new Set(input.entries.flatMap(entry => [entry.debit, entry.credit]))];
        const accounts = await trx("accounts").where({ group_id }).whereIn("id", accountIds)
          .orderBy("id").forShare().select("id", "cycle_id", "type", "code");
        const byId = new Map(accounts.map(account => [String(account.id), account]));
        for (const entry of input.entries) {
          const debit = byId.get(entry.debit);
          const credit = byId.get(entry.credit);
          if (!debit || !credit) fail("Selected accounts were not found in this group", 404);
          if (debit.type !== "ASSET") fail("Debit must be an ASSET account");
          if (!creditRules[entry.type](credit)) fail(`Invalid credit account for ${entry.type}`);
        }
        const cycle_id = input.cycle_id ?? accounts.find(account => account.cycle_id !== null)?.cycle_id ?? null;
        if (cycle_id === null) fail("A cycle is required for a member payment");
        if (accounts.some(account => account.cycle_id !== null && String(account.cycle_id) !== String(cycle_id))) {
          fail("Selected accounts must belong to the transaction cycle");
        }
        const cycle = await trx("cycles").where({ id: cycle_id, group_id }).forShare().first("id");
        if (!cycle) fail("Cycle not found in this group", 404);
        const member = await trx("users").where({ id: input.user_id, group_id }).forShare().first("id");
        if (!member) fail("Member not found in this group", 404);
        const membership = await trx("cycle_members").where({ user_id: input.user_id, cycle_id }).forShare().first("user_id");
        if (!membership) fail("Member does not belong to the transaction cycle");
        const [header] = await trx("transactions").insert({ group_id, cycle_id, user_id: input.user_id,
          type: "PAYMENT", amount: input.amount, description: input.description }).returning("id");
        const entries = [];
        const account_entries = [];
        for (const entry of input.entries) {
          // Insert each component explicitly so postings never depend on bulk RETURNING order.
          const [component] = await trx("transaction_entries").insert({ group_id, transaction_id: header.id,
            user_id: input.user_id, cycle_id, type: entry.type, amount: entry.amount, description: entry.description }).returning("*");
          entries.push(component);
          account_entries.push(...await trx("account_entries").insert([
            { group_id, transaction_entry_id: component.id, account_id: entry.debit, amount: entry.amount },
            { group_id, transaction_entry_id: component.id, account_id: entry.credit, amount: `-${entry.amount}` },
          ]).returning("*"));
        }
        const transaction = await trx("transactions").where({ id: header.id, group_id }).first(transactionColumns);
        return { transaction, entries, account_entries };
      });
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      if (["23503", "23514", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Payment could not be committed; refresh the selected records and retry" });
      }
      return next(error);
    }
  }
}

module.exports = PaymentTransactionsHandler;
