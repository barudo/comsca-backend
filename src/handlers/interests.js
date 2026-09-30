const transactionColumns = ["id", "group_id", "cycle_id", "user_id", "type", "amount",
  "description", "occurred_at", "created_at", "updated_at"];
const maximumCents = 999999999999999999n;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function id(value, field) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value))) fail(`${field} must be a positive ID`);
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
    fail(`${field} must be a valid positive ID`);
  }
  return text;
}

function interestInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["credit", "debit"].includes(key))) {
    fail("Provide only debit and credit account IDs");
  }
  const debit = id(body.debit, "debit");
  const credit = id(body.credit, "credit");
  if (debit === credit) fail("Debit and credit must use different accounts");
  return { debit, credit };
}

function cents(amount) {
  const match = /^(\d+)\.(\d{2})$/.exec(String(amount));
  if (!match) throw new Error("Invalid ledger amount");
  return BigInt(match[1]) * 100n + BigInt(match[2]);
}

function decimal(amountCents) {
  return `${amountCents / 100n}.${String(amountCents % 100n).padStart(2, "0")}`;
}

function reconstructBalances(events) {
  const balances = new Map();
  for (const event of events) {
    const userId = String(event.user_id);
    const balance = balances.get(userId) ?? { principal: 0n, interest: 0n };
    const amount = cents(event.amount);
    if (["LOAN_DISBURSED", "LOAN_DISBURSEMENT"].includes(event.type)) balance.principal += amount;
    if (event.type === "LOAN_INTEREST") balance.interest += amount;
    if (event.type === "LOAN_PAYMENT") {
      const interestPaid = amount < balance.interest ? amount : balance.interest;
      balance.interest -= interestPaid;
      const principalPaid = amount - interestPaid;
      balance.principal = principalPaid < balance.principal ? balance.principal - principalPaid : 0n;
    }
    balances.set(userId, balance);
  }
  return balances;
}

async function roundedInterest(trx, bases, rate) {
  const entries = [...bases.entries()].filter(([, base]) => base > 0n);
  const result = [];
  for (let offset = 0; offset < entries.length; offset += 500) {
    const batch = entries.slice(offset, offset + 500);
    const values = batch.map(() => "(?::bigint, ?::numeric)").join(", ");
    const bindings = [rate, ...batch.flatMap(([userId, base]) => [userId, String(base)])];
    const { rows } = await trx.raw(`
      SELECT value.user_id,
        ROUND((value.base_cents / 100) * ?::numeric / 100, 2)::text AS amount
      FROM (VALUES ${values}) AS value(user_id, base_cents)
    `, bindings);
    result.push(...rows);
  }
  return result;
}

class InterestsHandler {
  async charge(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER"].includes(actor.role)) {
          fail("Only an OWNER, ADMIN or TREASURER of this group can charge loan interest", 403);
        }
        const input = interestInput(request.body);
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc").forUpdate()
          .first("id", "interest_rate", "interest_period", "interest_method");
        if (!cycle) fail("The group has no active or distributing cycle", 409);
        if (cycle.interest_rate === null || cycle.interest_period === null || cycle.interest_method === null) {
          fail("The current cycle has no configured interest terms", 409);
        }

        const accounts = await trx("accounts").where({ group_id }).whereIn("id", [input.debit, input.credit])
          .orderBy("id").forShare().select("id", "cycle_id", "type");
        const debit = accounts.find(account => String(account.id) === input.debit);
        const credit = accounts.find(account => String(account.id) === input.credit);
        if (!debit || !credit) fail("Selected accounts were not found in this group", 404);
        if (accounts.some(account => account.cycle_id !== null && String(account.cycle_id) !== String(cycle.id))) {
          fail("Selected accounts must belong to the current cycle");
        }
        if (debit.type !== "ASSET") fail("Debit must be an ASSET account");
        if (credit.type !== "INCOME") fail("Credit must be an INCOME account");

        const { rows: events } = await trx.raw(`
          SELECT COALESCE(e.user_id, t.user_id) AS user_id, e.type, e.amount::text AS amount,
            t.occurred_at, t.id AS transaction_id, e.id AS entry_id
          FROM transaction_entries e
          JOIN transactions t ON t.id = e.transaction_id AND t.group_id = e.group_id
          JOIN users u ON u.id = COALESCE(e.user_id, t.user_id) AND u.group_id = e.group_id
          JOIN cycle_members cm ON cm.user_id = u.id AND cm.cycle_id = t.cycle_id
          WHERE e.group_id = ? AND t.group_id = ? AND t.cycle_id = ?
            AND (e.cycle_id IS NULL OR e.cycle_id = ?) AND u.group_id = ?
            AND e.type IN ('LOAN_DISBURSED', 'LOAN_DISBURSEMENT', 'LOAN_INTEREST', 'LOAN_PAYMENT')
          ORDER BY u.id, t.occurred_at, t.id, e.id
        `, [group_id, group_id, cycle.id, cycle.id, group_id]);
        const balances = reconstructBalances(events);
        const bases = new Map([...balances].map(([userId, balance]) => [userId,
          cycle.interest_method === "SIMPLE" ? balance.principal : balance.principal + balance.interest]));
        const interest = await roundedInterest(trx, bases, cycle.interest_rate);
        const entriesToPost = interest.map(row => ({ user_id: String(row.user_id), amount: cents(row.amount) }))
          .filter(entry => entry.amount > 0n);
        const totalCents = entriesToPost.reduce((total, entry) => total + entry.amount, 0n);
        if (totalCents === 0n) fail("No positive loan interest is chargeable", 409);
        if (entriesToPost.some(entry => entry.amount > maximumCents) || totalCents > maximumCents) {
          fail("Calculated interest exceeds the supported transaction amount", 409);
        }

        const amount = decimal(totalCents);
        const [header] = await trx("transactions").insert({ group_id, cycle_id: cycle.id, user_id: null,
          type: "LOAN_INTEREST", amount }).returning("id");
        const entries = [];
        const account_entries = [];
        for (let offset = 0; offset < entriesToPost.length; offset += 500) {
          const batch = await trx("transaction_entries").insert(entriesToPost.slice(offset, offset + 500).map(entry => ({
            group_id, transaction_id: header.id, cycle_id: cycle.id, user_id: entry.user_id,
            type: "LOAN_INTEREST", amount: decimal(entry.amount),
          }))).returning("*");
          entries.push(...batch);
          account_entries.push(...await trx("account_entries").insert(batch.flatMap(entry => [
            { group_id, transaction_entry_id: entry.id, account_id: input.debit, amount: entry.amount },
            { group_id, transaction_entry_id: entry.id, account_id: input.credit, amount: `-${entry.amount}` },
          ])).returning("*"));
        }
        const transaction = await trx("transactions").where({ id: header.id, group_id }).first(transactionColumns);
        return { transaction, entries, account_entries };
      });
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      if (["23001", "23503", "23505", "23514", "40001", "40P01", "22003"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Interest could not be committed; refresh the selected records and retry" });
      }
      return next(error);
    }
  }
}

module.exports = InterestsHandler;