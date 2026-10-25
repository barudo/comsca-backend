function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function amount(value) {
  if (!["string", "number"].includes(typeof value) ||
      (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000))) {
    fail("amount_desired must be a positive decimal; send large amounts as strings");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) fail("amount_desired must be positive with at most two decimal places");
  const whole = match[1].replace(/^0+/, "") || "0";
  const fraction = (match[2] || "").padEnd(2, "0");
  if (whole.length > 16 || BigInt(whole) * 100n + BigInt(fraction) === 0n) {
    fail("amount_desired must be greater than zero and fit numeric(18,2)");
  }
  return `${whole}.${fraction}`;
}

function userId(value) {
  if (!["string", "number"].includes(typeof value) ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) {
    fail("user_id must be a valid positive ID");
  }
  return String(value);
}

class LoanApplicationsHandler {
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const group_id = request.group.id;
        const actor = await trx("users")
          .where({ auth_user_id: request.authUser.id, group_id }).first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER", "AUDITOR"].includes(actor.role)) {
          fail("A financial role in this group is required to list loan applications", 403);
        }
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["draft", "active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc").first("id");
        if (!cycle) return { success: true, current_cycle_id: null, members: [] };
        const members = await trx("users as u")
          .join("cycle_members as cm", "cm.user_id", "u.id")
          .where({ "u.group_id": group_id, "cm.cycle_id": cycle.id })
          .select("u.id", "u.group_id", "u.first_name", "u.family_name", "u.username", "u.role")
          .orderBy("u.family_name").orderBy("u.first_name").orderBy("u.id");
        const applications = await trx("loan_applications")
          .where({ group_id, cycle_id: cycle.id, status: "active" })
          .distinctOn("user_id").select("*")
          .orderBy("user_id").orderBy("created_at", "desc").orderBy("id", "desc");
        const byUser = new Map(applications.map(application => [String(application.user_id), application]));
        return {
          success: true, current_cycle_id: cycle.id,
          members: members.map(member => ({
            ...member, loan_application: byUser.get(String(member.id)) || null,
          })),
        };
      });
      return response.json(result);
    } catch (error) {
      if (error.status === 403) {
        return response.status(403).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }

  async latestMe(request, response, next) {
    try {
      const database = request.app.locals.database;
      const group_id = request.group.id;
      const user = await database("users")
        .where({ auth_user_id: request.authUser.id, group_id })
        .first("id");
      if (!user) {
        return response.status(403).json({
          success: false, error: "You do not have a user profile in this group",
        });
      }
      const loan_application = await database("loan_applications")
        .where({ group_id, user_id: user.id, status: "active" })
        .orderBy("created_at", "desc").orderBy("id", "desc")
        .first("*");
      return response.json({ success: true, loan_application: loan_application || null });
    } catch (error) {
      return next(error);
    }
  }

  async create(request, response, next) {
    return this.save(request, response, next, "legacy");
  }

  async apply(request, response, next) {
    return this.save(request, response, next, "managed");
  }

  async applyMe(request, response, next) {
    return this.save(request, response, next, "self");
  }

  async save(request, response, next, mode) {
    try {
      const loan_application = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        const roles = mode === "managed" ? ["OWNER", "ADMIN", "TREASURER"]
          : mode === "self" ? ["MEMBER", "OWNER", "ADMIN", "TREASURER", "AUDITOR"]
          : ["MEMBER", "OWNER", "ADMIN", "TREASURER"];
        if (!actor || !roles.includes(actor.role)) {
          fail("Your role in this group cannot use this loan application endpoint", 403);
        }
        const self = mode === "self" || (mode === "legacy" && actor.role === "MEMBER");
        const body = request.body;
        const allowed = self ? ["amount_desired"] : ["user_id", "amount_desired"];
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some(key => !allowed.includes(key))) {
          fail("Invalid loan application fields");
        }
        const amount_desired = amount(body.amount_desired);
        const user_id = self ? actor.id : userId(body.user_id);
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["draft", "active"])
          .orderBy("created_at", "desc").orderBy("id", "desc")
          .forUpdate().first("id");
        if (!cycle) fail("This group has no current cycle", 409);
        const member = await trx("users").where({ id: user_id, group_id }).forShare().first("id");
        if (!member) fail("User not found in this group", 404);
        const membership = await trx("cycle_members").where({ user_id, cycle_id: cycle.id })
          .forShare().first("user_id");
        if (!membership) fail("User does not belong to the current cycle");
        if (mode === "managed") {
          await trx("loan_applications")
            .where({ group_id, user_id, status: "active" })
            .update({ status: "inactive", updated_at: trx.fn.now() });
        }
        const [application] = await trx("loan_applications").insert({
          group_id, user_id, cycle_id: cycle.id, amount_desired, status: "active",
        }).returning("*");
        return application;
      });
      return response.status(201).json({ success: true, loan_application });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      if (["23503", "23514", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Loan application could not be saved; refresh and retry" });
      }
      return next(error);
    }
  }
}

module.exports = LoanApplicationsHandler;
