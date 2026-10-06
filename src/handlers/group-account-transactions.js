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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(`Unsupported ${label} field`);
  }
}

function id(value, field) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    fail(`${field} must be a positive ID`);
  }
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
    fail(`${field} must be a valid positive ID`);
  }
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

function decimal(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function transactionInput(body, rules) {
  record(
    body,
    ["debit", "credit", "amount", "description", ...rules.extraFields],
    rules.label,
  );
  const debit = id(body.debit, "debit");
  const credit = id(body.credit, "credit");
  if (debit === credit) fail("Debit and credit must use different accounts");
  if (!["string", "number"].includes(typeof body.amount)) {
    fail("amount must be a positive decimal");
  }
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
  if (whole.length > 16) fail("amount must fit numeric(18,2)");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents === 0n) fail("amount must be greater than zero");

  if (
    rules.requireDescription &&
    (typeof body.description !== "string" || !body.description.trim())
  ) {
    fail("description is required and must be nonblank text");
  }
  const hasDescription = Object.hasOwn(body, "description");
  const hasRemarks = Object.hasOwn(body, "remarks");
  if (hasDescription && hasRemarks && body.description !== body.remarks) {
    fail("description and remarks must match when both are supplied");
  }
  return {
    debit,
    credit,
    amount: decimal(cents),
    description: description(hasDescription ? body.description : body.remarks),
  };
}

class GroupAccountTransactionsHandler {
  constructor(rules) {
    this.rules = rules;
  }

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
              `Only an OWNER, ADMIN or TREASURER of this group can record ${this.rules.label}s`,
              403,
            );
          }

          const input = transactionInput(request.body, this.rules);
          const cycle = await trx("cycles")
            .where({ group_id })
            .whereIn("status", ["active", "distributing"])
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .forUpdate()
            .first("id");
          if (!cycle) fail("This group has no writable current cycle", 409);

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
          if (!debit || !credit) {
            fail("Selected accounts were not found in this group", 404);
          }
          if (
            accounts.some(
              (account) => String(account.cycle_id) !== String(cycle.id),
            )
          ) {
            fail("Selected accounts must belong to the current cycle");
          }
          this.rules.validateAccounts(debit, credit, fail);

          const [header] = await trx("transactions")
            .insert({
              group_id,
              cycle_id: cycle.id,
              user_id: null,
              type: this.rules.type,
              amount: input.amount,
              description: input.description,
            })
            .returning("id");
          const [component] = await trx("transaction_entries")
            .insert({
              group_id,
              transaction_id: header.id, debit: input.debit, credit: input.credit,
              user_id: null,
              cycle_id: cycle.id,
              type: this.rules.type,
              amount: input.amount,
              description: input.description,
            })
            .returning("*");
          const account_entries = await trx("account_entries")
            .insert([
              {
                group_id,
                transaction_entry_id: component.id,
                account_id: input.debit,
                amount: input.amount,
              },
              {
                group_id,
                transaction_entry_id: component.id,
                account_id: input.credit,
                amount: `-${input.amount}`,
              },
            ])
            .returning("*");
          const transaction = await trx("transactions")
            .where({ id: header.id, group_id })
            .first(transactionColumns);
          return { transaction, entries: [component], account_entries };
        },
      );
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) {
        return response
          .status(error.status)
          .json({ success: false, error: error.message });
      }
      if (
        ["23001", "23503", "23505", "23514", "40001", "40P01"].includes(
          error.code,
        )
      ) {
        return response.status(409).json({
          success: false,
          error:
            `${this.rules.label[0].toUpperCase()}${this.rules.label.slice(1)} could not be committed; refresh the selected records and retry`,
        });
      }
      return next(error);
    }
  }
}

module.exports = GroupAccountTransactionsHandler;
