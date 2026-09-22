exports.up = async function up(knex) {
  // Knex runs this migration transactionally. Block writers across the preflight
  // and conversion so legacy requests cannot add a conflicting cycle mid-flight.
  await knex.raw("LOCK TABLE public.cycles IN ACCESS EXCLUSIVE MODE");
  const conflicts = await knex("cycles").select("group_id")
    .whereIn("status", ["active", "distributing"])
    .groupBy("group_id").havingRaw("count(*) > 1");
  if (conflicts.length) {
    throw new Error("Cycle lifecycle migration blocked: groups have multiple active/distributing cycles. Reconcile their actual lifecycle states before retrying; no cycles were converted.");
  }
  await knex.raw("DROP INDEX public.cycles_one_active_per_group");
  await knex.schema.alterTable("cycles", table => table.dropChecks("cycles_status_check"));
  // Inactive historically did not distinguish completed cycles from unstarted
  // ones. Treat them as history rather than granting permission to edit them.
  await knex("cycles").where({ status: "inactive" }).update({ status: "closed" });
  await knex.raw("ALTER TABLE public.cycles ALTER COLUMN status SET DEFAULT 'draft'");
  await knex.schema.alterTable("cycles", table => {
    table.check("status IN ('draft', 'active', 'distributing', 'closed')", [], "cycles_status_check");
  });
  await knex.raw(`CREATE UNIQUE INDEX cycles_one_current_per_group
    ON public.cycles (group_id) WHERE status <> 'closed'`);
  await knex.raw("GRANT SELECT (status) ON public.cycles TO comsca_group_reader");
};

exports.down = async function down(knex) {
  await knex.raw("LOCK TABLE public.cycles IN ACCESS EXCLUSIVE MODE");
  await knex.raw("REVOKE SELECT (status) ON public.cycles FROM comsca_group_reader");
  await knex.raw("DROP INDEX public.cycles_one_current_per_group");
  await knex.schema.alterTable("cycles", table => table.dropChecks("cycles_status_check"));
  // The old schema cannot distinguish drafts from closed history. Operators
  // must restore the matching older application and keep traffic paused.
  await knex("cycles").whereIn("status", ["draft", "closed"]).update({ status: "inactive" });
  await knex.raw("ALTER TABLE public.cycles ALTER COLUMN status SET DEFAULT 'inactive'");
  await knex.schema.alterTable("cycles", table => {
    table.check("status IN ('active', 'inactive', 'distributing')", [], "cycles_status_check");
  });
  await knex.raw(`CREATE UNIQUE INDEX cycles_one_active_per_group
    ON public.cycles (group_id) WHERE status = 'active'`);
};
