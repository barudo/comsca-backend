const accountColumns = ["id", "group_id", "cycle_id", "code", "name", "type",
  "description", "created_at", "updated_at"];

class CycleAccountsHandler {
  async list(request, response, next) {
    try {
      const db = request.app.locals.database;
      const result = await db.transaction(async trx => {
        const actor = await trx("users").where({
          auth_user_id: request.authUser.id, group_id: request.group.id,
        }).forShare().first("id", "role");
        if (!actor || !["OWNER", "ADMIN", "TREASURER", "AUDITOR"].includes(actor.role)) {
          throw Object.assign(new Error("A financial role in this group is required to list accounts"), { status: 403 });
        }
        await trx.raw("SET LOCAL ROLE comsca_group_reader");
        await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(request.group.id)]);
        const cycle = await trx("cycles").where({ group_id: request.group.id })
          .whereIn("status", ["draft", "active", "distributing"])
          .orderBy("created_at", "desc").orderBy("id", "desc").first("id");
        const accounts = cycle ? await trx("accounts")
          .where({ group_id: request.group.id, cycle_id: cycle.id })
          .select(accountColumns).orderBy("code").orderBy("id") : [];
        return { success: true, current_cycle_id: cycle?.id ?? null, accounts };
      });
      return response.json(result);
    } catch (error) {
      if (error.status === 403) return response.status(403).json({ success: false, error: error.message });
      return next(error);
    }
  }
}

module.exports = CycleAccountsHandler;
