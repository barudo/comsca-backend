function memberIds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "users") ||
      !Array.isArray(body.users) || !body.users.length || body.users.length > 1000) {
    throw Object.assign(new Error("Provide users as an array of 1 to 1000 user IDs"), { status: 400 });
  }
  const ids = body.users.map(value => {
    if (!["string", "number"].includes(typeof value) ||
        (typeof value === "number" && !Number.isSafeInteger(value)) ||
        !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) {
      throw Object.assign(new Error("Each user ID must be a positive integer; use strings for large IDs"), { status: 400 });
    }
    return String(value);
  });
  return [...new Set(ids)];
}

class CycleMembersHandler {
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        // Authorization, cycle selection, roster and balances share one snapshot.
        // The restricted group reader has no ledger grants; scope backend reads explicitly.
        await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER", "AUDITOR"].includes(actor.role)) {
          throw Object.assign(new Error("A financial role in this group is required to list member balances"), { status: 403 });
        }
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc").first("id");
        if (!cycle) return { success: true, current_cycle_id: null, members: [] };
        const { rows: members } = await trx.raw(`
          SELECT u.id, u.group_id, u.first_name, u.family_name, u.username,
            u.email, u.phone, u.address, u.role, u.created_at, u.updated_at,
            COALESCE(b.total_shares, 0.00)::text AS total_shares,
            COALESCE(b.remaining_loan, 0.00)::text AS remaining_loan,
            COALESCE(b.unpaid_penalties, 0.00)::text AS unpaid_penalties,
            COALESCE(b.unpaid_contributions, 0.00)::text AS unpaid_contributions
          FROM users u
          JOIN cycle_members cm ON cm.user_id = u.id AND cm.cycle_id = ?
          LEFT JOIN (
            SELECT COALESCE(e.user_id, t.user_id) AS user_id,
              SUM(CASE WHEN e.type = 'BUY_SHARE' THEN e.amount ELSE 0.00 END) AS total_shares,
              SUM(CASE WHEN e.type IN ('LOAN_DISBURSED', 'LOAN_DISBURSEMENT', 'LOAN_INTEREST') THEN e.amount
                WHEN e.type = 'LOAN_PAYMENT' THEN -e.amount ELSE 0.00 END) AS remaining_loan,
              SUM(CASE WHEN e.type = 'CHARGE_PENALTY' THEN e.amount
                WHEN e.type = 'PENALTY_PAYMENT' THEN -e.amount ELSE 0.00 END) AS unpaid_penalties,
              SUM(CASE WHEN e.type IN ('CHARGE_CONTRIBUTION', 'CONTRIBUTION') THEN e.amount
                WHEN e.type = 'PAY_CONTRIBUTION' THEN -e.amount ELSE 0.00 END) AS unpaid_contributions
            FROM transaction_entries e
            JOIN transactions t ON t.id = e.transaction_id AND t.group_id = e.group_id
            WHERE e.group_id = ? AND t.group_id = ? AND t.cycle_id = ?
            GROUP BY COALESCE(e.user_id, t.user_id)
          ) b ON b.user_id = u.id
          WHERE u.group_id = ?
          ORDER BY u.family_name, u.first_name, u.id
        `, [cycle.id, group_id, group_id, cycle.id, group_id]);
        return { success: true, current_cycle_id: cycle.id, members };
      });
      return response.json(result);
    } catch (error) {
      if (error.status === 403) return response.status(403).json({ success: false, error: error.message });
      return next(error);
    }
  }

  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        const group_id = request.group.id;
        const actor = await trx("users").where({ auth_user_id: request.authUser.id, group_id })
          .forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
          throw Object.assign(new Error("Only an OWNER or ADMIN of this group can add cycle members"), { status: 403 });
        }
        const users = memberIds(request.body);
        // Serialize enrollment with lifecycle changes and other enrollments.
        const cycle = await trx("cycles").where({ group_id })
          .whereIn("status", ["draft", "active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc")
          .forUpdate().first("id");
        if (!cycle) throw Object.assign(new Error("This group has no current cycle"), { status: 409 });
        // Hold membership/group identity stable until the insert commits.
        const found = await trx("users").where({ group_id }).whereIn("id", users)
          .orderBy("id").forShare().select("id");
        if (found.length !== users.length) {
          throw Object.assign(new Error("One or more users were not found in this group"), { status: 404 });
        }
        const added = await trx("cycle_members")
          .insert(found.map(user => ({ cycle_id: cycle.id, user_id: user.id })))
          .onConflict(["cycle_id", "user_id"]).ignore().returning("user_id");
        return { success: true, current_cycle_id: cycle.id, users, added_count: added.length };
      });
      return response.json(result);
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      if (["23503", "40001", "40P01"].includes(error.code)) {
        return response.status(409).json({ success: false, error: "Cycle membership changed; refresh and retry" });
      }
      return next(error);
    }
  }
}

module.exports = CycleMembersHandler;
