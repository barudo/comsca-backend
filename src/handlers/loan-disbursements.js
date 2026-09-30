const transactionColumns = [
  "id",
  "group_id",
  "cycle_id",
  "user_id",
  "type",
  "amount",
  "description",
  "occurred_at",
  "created_at",
  "updated_at",
];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function record(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail(`Unsupported ${label} field`);
}

function id(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  )
    fail(`${field} must be a positive ID`);
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n)
    fail(`${field} must be a valid positive ID`);
  return text;
}

function description(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    value.length > 4000
  ) {
    fail(
      "description must be a string of at most 4000 characters without null characters",
    );
  }
  return value;
}

function disbursementInput(body) {
  record(
    body,
    ["user_id", "cycle_id", "description", "debit", "credit", "amount"],
    "loan disbursement",
  );
  const user_id = id(body.user_id, "user_id");
  const cycle_id = id(body.cycle_id, "cycle_id", true);
  const debit = id(body.debit, "debit");
  const credit = id(body.credit, "credit");
  if (debit === credit) fail("Debit and credit must use different accounts");
  if (!["string", "number"].includes(typeof body.amount))
    fail("amount must be a positive decimal");
  if (
    typeof body.amount === "number" &&
    (!Number.isFinite(body.amount) || Math.abs(body.amount) > 1_000_000_000_000)
  ) {
    fail("Send large amounts as decimal strings to preserve precision");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(body.amount));
  if (!match) fail("amount must be positive with at most two decimal places");
  const whole = match[1].replace(/^0+/, "") || "0";
  const fraction = (match[2] || "").padEnd(2, "0");
  if (whole.length > 16 || !/[1-9]/.test(whole + fraction))
    fail("amount must be greater than zero and fit numeric(18,2)");
  return {
    user_id,
    cycle_id,
    debit,
    credit,
    amount: `${whole}.${fraction}`,
    description: description(body.description),
  };
}

class LoanDisbursementsHandler {
  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(
        async (trx) => {
          const group_id = request.group.id;
          const actor = await trx("users")
            .where({ auth_user_id: request.authUser.id, group_id })
            .forShare()
            .first("id", "role");
          if (!actor || !["OWNER", "ADMIN", "TREASURER"].includes(actor.role)) {
            fail(
              "Only an OWNER, ADMIN or TREASURER of this group can disburse loans",
              403,
            );
          }
          const input = disbursementInput(request.body);
          const accounts = await trx("accounts")
            .where({ group_id })
            .whereIn("id", [input.debit, input.credit])
            .orderBy("id")
            .forShare()
            .select("id", "cycle_id", "type", "code");
          const debit = accounts.find(
            (account) => String(account.id) === input.debit,
          );
          const credit = accounts.find(
            (account) => String(account.id) === input.credit,
          );
          if (!debit || !credit)
            fail("Selected accounts were not found in this group", 404);
          if (debit.type !== "ASSET" || debit.code !== "1100")
            fail("Debit must be Loans Receivable (1100), an ASSET account");
          if (credit.type !== "ASSET")
            fail("Credit must be an ASSET funding account");
          const cycle_id =
            input.cycle_id ??
            accounts.find((account) => account.cycle_id !== null)?.cycle_id ??
            null;
          if (cycle_id === null)
            fail("A cycle is required for a member loan disbursement");
          if (
            accounts.some(
              (account) =>
                account.cycle_id !== null &&
                String(account.cycle_id) !== String(cycle_id),
            )
          ) {
            fail("Selected accounts must belong to the transaction cycle");
          }
          const cycle = await trx("cycles")
            .where({ id: cycle_id, group_id })
            .forShare()
            .first("id");
          if (!cycle) fail("Cycle not found in this group", 404);
          const member = await trx("users")
            .where({ id: input.user_id, group_id })
            .forShare()
            .first("id");
          if (!member) fail("Member not found in this group", 404);
          const membership = await trx("cycle_members")
            .where({ user_id: input.user_id, cycle_id })
            .forShare()
            .first("user_id");
          if (!membership)
            fail("Member does not belong to the transaction cycle");
          const [header] = await trx("transactions")
            .insert({
              group_id,
              cycle_id,
              user_id: input.user_id,
              type: "LOAN_DISBURSED",
              amount: input.amount,
              description: input.description,
            })
            .returning("id");
          const entries = await trx("transaction_entries")
            .insert({
              group_id,
              transaction_id: header.id,
              user_id: input.user_id,
              cycle_id,
              type: "LOAN_DISBURSED",
              amount: input.amount,
              description: input.description,
            })
            .returning("*");
          const account_entries = await trx("account_entries")
            .insert([
              {
                group_id,
                transaction_entry_id: entries[0].id,
                account_id: input.debit,
                amount: input.amount,
              },
              {
                group_id,
                transaction_entry_id: entries[0].id,
                account_id: input.credit,
                amount: `-${input.amount}`,
              },
            ])
            .returning("*");
          const transaction = await trx("transactions")
            .where({ id: header.id, group_id })
            .first(transactionColumns);
          return { transaction, entries, account_entries };
        },
      );
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404].includes(error.status))
        return response
          .status(error.status)
          .json({ success: false, error: error.message });
      if (["23503", "23514", "40001", "40P01"].includes(error.code)) {
        return response
          .status(409)
          .json({
            success: false,
            error:
              "Loan disbursement could not be committed; refresh the selected records and retry",
          });
      }
      return next(error);
    }
  }
}

module.exports = LoanDisbursementsHandler;
