const transactionColumns = ["id", "group_id", "cycle_id", "user_id", "type", "amount",
  "description", "occurred_at", "created_at", "updated_at"];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

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

function contributionInput(body) {
  record(body, ["description", "debit", "credit", "amount"], "contribution charge");
  const debit = id(body.debit, "debit");
  const credit = id(body.credit, "credit");
  if (debit === credit) fail("Debit and credit must use different accounts");
  if (!["string", "number"].includes(typeof body.amount)) fail("amount must be a positive decimal");
  if (typeof body.amount === "number" && (!Number.isFinite(body.amount) || Math.abs(body.amount) > 1_000_000_000_000)) {
    fail("Send large amounts as decimal strings to preserve precision");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(body.amount));
  if (!match) fail("amount must be positive with at most two decimal places");
  const whole = match[1].replace(/^0+/, "") || "0";
  const fraction = (match[2] || "").padEnd(2, "0");
  if (whole.length > 16 || !/[1-9]/.test(whole + fraction)) fail("amount must be greater than zero and fit numeric(18,2)");
  return { debit, credit, amount: `${whole}.${fraction}`, description: description(body.description) };
}

class ContributionsHandler {
  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER"].includes(actor.role)) {
          fail("Only an OWNER, ADMIN or TREASURER of this group can charge contributions", 403);
        }
        const input = contributionInput(request.body);
        // Share the enrollment/lifecycle lock so the charge sees a stable roster.
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["draft", "active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc").forUpdate().first("id");
        if (!cycle) fail("This group has no current cycle", 409);
        const members = await trx("cycle_members").join("users", "users.id", "cycle_members.user_id")
          .where({ "cycle_members.cycle_id": cycle.id, "users.group_id": group_id })
          .orderBy("cycle_members.user_id").forShare().select("cycle_members.user_id");
        if (!members.length) fail("The current cycle has no enrolled members", 409);
        const cents = BigInt(input.amount.replace(".", "")) * BigInt(members.length);
        if (cents > 999999999999999999n) fail("Total contributions must fit numeric(18,2)");
        const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
        const accounts = await trx("accounts").where({ group_id }).whereIn("id", [input.debit, input.credit])
          .orderBy("id").forShare().select("id", "cycle_id", "type", "code");
        const debit = accounts.find(account => String(account.id) === input.debit);
        const credit = accounts.find(account => String(account.id) === input.credit);
        if (!debit || !credit) fail("Selected accounts were not found in this group", 404);
        if (accounts.some(account => account.cycle_id !== null && String(account.cycle_id) !== String(cycle.id))) {
          fail("Selected accounts must belong to the current cycle");
        }
        if (debit.type !== "ASSET" || debit.code !== "1400") fail("Debit must be Contributions Receivable (1400), an ASSET account");
        if (credit.type !== "INCOME" || credit.code !== "4400") fail("Credit must be Contribution Income (4400), an INCOME account");
        const [header] = await trx("transactions").insert({ group_id, cycle_id: cycle.id, user_id: null,
          type: "CONTRIBUTION", amount, description: input.description }).returning("id");
        const entries = [];
        const account_entries = [];
        // Bound each statement's parameter count for large cycle rosters.
        for (let offset = 0; offset < members.length; offset += 1000) {
          const batch = await trx("transaction_entries").insert(members.slice(offset, offset + 1000).map(member => ({
            group_id, transaction_id: header.id, debit: input.debit, credit: input.credit, cycle_id: cycle.id, user_id: member.user_id,
            type: "CHARGE_CONTRIBUTION", amount: input.amount, description: input.description,
          }))).returning("*");
          entries.push(...batch);
          const postings = await trx("account_entries").insert(batch.flatMap(entry => [
            { group_id, transaction_entry_id: entry.id, account_id: input.debit, amount: input.amount },
            { group_id, transaction_entry_id: entry.id, account_id: input.credit, amount: `-${input.amount}` },
          ])).returning("*");
          account_entries.push(...postings);
        }
        const transaction = await trx("transactions").where({ id: header.id, group_id }).first(transactionColumns);
        return { transaction, entries, account_entries };
      });
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      if (["23001", "23503", "23505", "23514", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Contributions could not be committed; refresh the selected records and retry" });
      }
      return next(error);
    }
  }
}

module.exports = ContributionsHandler;
