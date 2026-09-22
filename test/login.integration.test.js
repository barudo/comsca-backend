const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const knex = require("knex");
const path = require("node:path");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");


async function waitForLocks(connection, pids) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await connection.raw(
      "SELECT bool_and(cardinality(pg_blocking_pids(pid)) > 0) AS blocked FROM unnest(?::int[]) AS pid", [pids]);
    if (rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Expected all competing requests to be blocked before releasing the writer");
}

test("login and RLS isolate groups on a reused database connection", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  // TEST_DATABASE_URL must point at an empty, disposable database.
  const db = knex({
    client: "pg", connection: process.env.TEST_DATABASE_URL,
    pool: { min: 0, max: 1 },
    migrations: { directory: path.join(__dirname, "../migrations") },
  });
  t.after(() => db.destroy());
  // Minimal Auth table for trigger tests; no external Supabase calls are made.
  await db.schema.createSchema("auth");
  await db.schema.withSchema("auth").createTable("users", (table) => {
    table.uuid("id").primary();
    table.string("phone");
    table.jsonb("raw_user_meta_data");
    table.jsonb("raw_app_meta_data");
    table.timestamp("phone_confirmed_at", { useTz: true });
  });
  await db.migrate.latest();
  const groups = await db("groups").insert([
    { name: "Alpha", slug: "alpha" }, { name: "Beta", slug: "beta" },
  ]).returning("id");
  const hash = await bcrypt.hash("alpha-password", 4);
  await db("users").insert([
    { group_id: groups[0].id, username: "member", password: hash,
      first_name: "Alpha", family_name: "Member", email: "alpha@example.test" },
    { group_id: groups[1].id, username: "member", password: await bcrypt.hash("beta-password", 4),
      first_name: "Beta", family_name: "Member", email: "beta@example.test" },
  ]);
  const server = await new Promise((resolve, reject) => {
    const server = createApp(db).listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/auth/login`;
  async function login(slug, body) {
    const headers = { "content-type": "application/json" };
    if (slug) headers["x-group-slug"] = slug;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const credentials = { username: "member", password: "alpha-password" };
  assert.equal((await login(null, credentials)).status, 400);
  assert.equal((await login("missing", credentials)).status, 404);
  for (const body of [{}, { username: {}, password: "x" },
    { username: "member", password: "é".repeat(37) }]) {
    assert.equal((await login("alpha", body)).status, 400);
  }
  const success = await login("alpha", credentials);
  assert.equal(success.status, 200);
  assert.equal(success.body.user.group_id, groups[0].id);
  assert.equal(success.body.user.first_name, "Alpha");
  assert.equal("password" in success.body.user, false);
  const wrongGroup = await login("beta", credentials);
  assert.equal(wrongGroup.status, 401);
  const wrongPassword = await login("alpha", { ...credentials, password: "wrong" });
  const missingUser = await login("alpha", { ...credentials, username: "missing" });
  assert.deepEqual(wrongPassword, wrongGroup);
  assert.deepEqual(missingUser, wrongGroup);
  assert.equal((await login("beta", { ...credentials, password: "beta-password" })).status, 200);

  // Query without an application WHERE: PostgreSQL itself must hide other groups.
  await db.transaction(async (trx) => {
    await trx.raw("SET LOCAL ROLE comsca_login");
    assert.deepEqual(await trx("users").select("id"), []);
    await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(groups[0].id)]);
    const visible = await trx("users").select("group_id");
    assert.deepEqual(visible, [{ group_id: groups[0].id }]);
    assert.deepEqual(await trx("users").select("id").where({ group_id: groups[1].id }), []);
  });
  await db.transaction(async (trx) => {
    await trx.raw("SET LOCAL ROLE comsca_login");
    assert.deepEqual(await trx("users").select("id"), []);
  });
  await assert.rejects(db.transaction(async (trx) => {
    await trx.raw("SET LOCAL ROLE comsca_login");
    await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(groups[0].id)]);
    await trx("users").where({ username: "member" }).update({ first_name: "Forbidden" });
  }), { code: "42501" });
  await db.transaction(async (trx) => {
    await trx.raw("SET LOCAL ROLE comsca_login");
    assert.deepEqual(await trx("users").select("id"), []);
  });
  await t.test("cycle status backfills, validates, isolates active cycles, and rolls back", async () => {
    await db.migrate.down(); // Remove 013 column grants.
    await db.migrate.down(); // Remove 012 before exercising the legacy migration.
    await db.migrate.down(); // Remove 011 to exercise pre-existing rows.
    const existing = await db("cycles").insert([
      { group_id: groups[0].id, interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "SIMPLE", cost_per_share: "100.00" },
      { group_id: groups[0].id }, { group_id: groups[1].id },
    ]).returning("id");
    const ids = existing.map(row => row.id);
    const member = await db("users").where({ group_id: groups[0].id }).first("id");
    await db("cycle_members").insert({ cycle_id: ids[0], user_id: member.id });
    const before = await db("cycles").whereIn("id", ids).orderBy("id");
    const membership = await db("cycle_members").where({ cycle_id: ids[0] });
    await db.migrate.up({ name: "011_add_cycle_status.js" });
    const withoutStatus = rows => rows.map(({ status, ...row }) => row);
    assert.deepEqual(withoutStatus(await db("cycles").whereIn("id", ids).orderBy("id")), before);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: ids[0] }), membership);
    assert.deepEqual((await db("cycles").whereIn("id", ids).orderBy("id").select("status")).map(row => row.status),
      ["inactive", "inactive", "inactive"]);
    const [defaultCycle] = await db("cycles").insert({ group_id: groups[0].id }).returning(["id", "status"]);
    ids.push(defaultCycle.id);
    assert.equal(defaultCycle.status, "inactive");
    for (const status of ["active", "inactive", "distributing"]) {
      await db("cycles").where({ id: ids[0] }).update({ status });
    }
    for (const status of ["ACTIVE", "ended", ""]) {
      await assert.rejects(db("cycles").where({ id: ids[0] }).update({ status }), { code: "23514" });
    }
    await assert.rejects(db("cycles").where({ id: ids[0] }).update({ status: null }), { code: "23502" });
    await db("cycles").where({ id: ids[0] }).update({ status: "active" });
    await db("cycles").where({ id: ids[2] }).update({ status: "active" });
    await assert.rejects(db("cycles").insert({ group_id: groups[0].id, status: "active" }),
      { code: "23505", constraint: "cycles_one_active_per_group" });
    await assert.rejects(db("cycles").where({ id: ids[1] }).update({ status: "active" }), { code: "23505" });
    await db("cycles").where({ id: ids[0] }).update({ status: "distributing" });
    await db("cycles").where({ id: ids[1] }).update({ status: "active" });
    await db("cycles").where({ id: ids[1] }).update({ status: "inactive" });
    await db("cycles").where({ id: defaultCycle.id }).update({ status: "distributing" });

    // Two actual connections race to activate cycles in the same group.
    const concurrent = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } });
    try {
      const first = await concurrent.transaction();
      const second = await concurrent.transaction();
      try {
        await first("cycles").where({ id: ids[0] }).update({ status: "active" });
        const { rows: [{ pid }] } = await second.raw("SELECT pg_backend_pid() AS pid");
        const competing = second("cycles").where({ id: ids[1] }).update({ status: "active" })
          .then(() => null, error => error);
        // Observe the actual lock wait before releasing the first writer.
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const { rows } = await db.raw("SELECT cardinality(pg_blocking_pids(?)) > 0 AS blocked", [pid]);
          if (rows[0].blocked) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "Competing activation must wait on the first transaction");
        await first.commit();
        const error = await competing;
        assert.equal(error?.code, "23505");
        assert.equal(error?.constraint, "cycles_one_active_per_group");
      } finally {
        if (!first.isCompleted()) await first.rollback();
        if (!second.isCompleted()) await second.rollback();
      }
    } finally {
      await concurrent.destroy();
    }
    await db.migrate.down();
    assert.equal(await db.schema.hasColumn("cycles", "status"), false);
    assert.equal((await db("cycles").whereIn("id", ids)).length, ids.length);
    assert.deepEqual(await db("cycles").whereIn("id", existing.map(row => row.id)).orderBy("id"), before);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: ids[0] }), membership);
    await db.migrate.up({ name: "011_add_cycle_status.js" });
    assert.equal((await db("cycles").whereIn("id", ids).select("status")).every(row => row.status === "inactive"), true);
    await db("cycles").whereIn("id", ids).del();
    await db.migrate.latest();
  });

  await t.test("current-cycle migration preserves history and blocks ambiguous ongoing groups atomically", async () => {
    await db.migrate.down(); // Remove 013 column grants.
    await db.migrate.down(); // 012: exercise actual legacy data under 011.
    const [legacy, active, distributing, conflict] = await db("cycles").insert([
      { group_id: groups[0].id, status: "inactive", cost_per_share: "100.00" },
      { group_id: groups[0].id, status: "active" },
      { group_id: groups[1].id, status: "distributing" },
      { group_id: groups[0].id, status: "distributing" },
    ]).returning("*");
    const member = await db("users").where({ group_id: groups[0].id }).first("id");
    await db("cycle_members").insert({ cycle_id: legacy.id, user_id: member.id });
    const before = await db("cycles").orderBy("id");
    const memberships = await db("cycle_members").where({ cycle_id: legacy.id });
    await assert.rejects(db.migrate.latest(), /multiple active\/distributing cycles/);
    assert.deepEqual(await db("cycles").orderBy("id"), before);
    assert.equal(await db("knex_migrations").where({ name: "012_current_cycle_lifecycle.js" }).first(), undefined);
    // Resolve only the deliberately conflicting test row, then retry.
    await db("cycles").where({ id: conflict.id }).del();
    await db.migrate.latest();
    const savedLegacy = await db("cycles").where({ id: legacy.id }).first();
    assert.deepEqual(savedLegacy, { ...legacy, status: "closed" });
    assert.deepEqual(await db("cycles").where({ id: active.id }).first(), active);
    assert.deepEqual(await db("cycles").where({ id: distributing.id }).first(), distributing);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: legacy.id }), memberships);
    for (const status of ["draft", "active", "distributing"]) {
      await assert.rejects(db("cycles").insert({ group_id: groups[0].id, status }),
        { code: "23505", constraint: "cycles_one_current_per_group" });
      await assert.rejects(db("cycles").where({ id: legacy.id }).update({ status }), { code: "23505" });
    }
    for (const status of ["inactive", "DRAFT", "ended"]) {
      await assert.rejects(db("cycles").where({ id: legacy.id }).update({ status }), { code: "23514" });
    }
    await assert.rejects(db("cycles").where({ id: legacy.id }).update({ status: null }), { code: "23502" });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(groups[0].id)]);
      const visible = await trx("cycles").select("group_id", "status");
      assert.equal(visible.length, 2);
      assert.equal(visible.every(row => row.group_id === groups[0].id), true);
    });
    const [emptyGroup] = await db("groups").insert({ name: "Lifecycle test", slug: "lifecycle-test" }).returning("id");
    const [draft] = await db("cycles").insert({ group_id: emptyGroup.id }).returning("*");
    assert.equal(draft.status, "draft");
    await db("cycles").insert([{ group_id: emptyGroup.id, status: "closed" }, { group_id: emptyGroup.id, status: "closed" }]);
    await db.migrate.down(); // Remove 013 column grants.
    await db.migrate.down();
    assert.equal((await db("cycles").where({ id: draft.id }).first()).status, "inactive");
    assert.deepEqual(await db("cycles").where({ id: legacy.id }).first(), legacy);
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx("cycles").select("status");
    }), { code: "42501" });
    await db.migrate.latest();
    assert.equal((await db("cycles").where({ id: draft.id }).first()).status, "closed");
    assert.deepEqual(await db("cycle_members").where({ cycle_id: legacy.id }), memberships);
    await db("cycles").whereIn("id", [legacy.id, active.id, distributing.id]).del();
    await db("groups").where({ id: emptyGroup.id }).del();
  });

  await db.migrate.down(); // Cycle list column grants
  await db.migrate.down(); // Current-cycle lifecycle
  await db.migrate.down(); // Cycle status
  await db.migrate.down(); // Group reader RLS
  // Roll back provisioning and roles, then prove both can be applied again.
  await db.migrate.down();
  await db.migrate.down();
  assert.equal(await db.schema.hasColumn("users", "role"), false);
  await db.migrate.latest();

  await t.test("group roles default to member and only accept the five defined roles", async () => {
    const user = await db("users").where({ group_id: groups[0].id }).first();
    assert.equal(user.role, "MEMBER");
    for (const role of ["OWNER", "ADMIN", "TREASURER", "MEMBER", "AUDITOR"]) {
      await db("users").where({ id: user.id }).update({ role });
      assert.equal((await db("users").where({ id: user.id }).first()).role, role);
    }
    for (const role of ["SUPERADMIN", "admin", ""]) {
      await assert.rejects(db("users").where({ id: user.id }).update({ role }), { code: "23514" });
    }
    await assert.rejects(db("users").where({ id: user.id }).update({ role: null }), { code: "23502" });
    await db("users").where({ id: user.id }).update({ role: "MEMBER" });
  });

  await t.test("cycle financial settings validate terms without inventing defaults", async () => {
    const group_id = groups[0].id;
    const [cycle] = await db("cycles").insert({ group_id, status: "closed" }).returning("*");
    for (const field of ["interest_rate", "interest_period", "interest_method", "cost_per_share"]) {
      assert.equal(cycle[field], null);
    }
    const terms = { interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "COMPOUND", cost_per_share: "100.00" };
    await db("cycles").where({ id: cycle.id }).update(terms);
    const saved = await db("cycles").where({ id: cycle.id }).first();
    for (const [key, value] of Object.entries(terms)) assert.equal(saved[key], value);
    for (const invalid of [
      { interest_rate: "-1" }, { interest_rate: "NaN" },
      { interest_period: "UNKNOWN" }, { interest_method: "UNKNOWN" },
      { interest_rate: null }, { interest_period: null }, { interest_method: null },
      { cost_per_share: "0" }, { cost_per_share: "-1" }, { cost_per_share: "NaN" },
    ]) {
      await assert.rejects(db("cycles").where({ id: cycle.id }).update(invalid), { code: "23514" });
    }
    await assert.rejects(db("cycles").insert({ group_id, interest_rate: "2.5" }), { code: "23514" });
    await db("cycles").where({ id: cycle.id }).update({ interest_rate: "0", interest_method: "SIMPLE" });
    await db("cycles").insert({ group_id, cost_per_share: "50.00", status: "closed" });
  });

  await t.test("accounting enforces balanced entries and group boundaries", async () => {
    const group_id = groups[0].id;
    const [cash, loans, interest, otherCash] = await db("accounts").insert([
      { group_id, code: "1000", name: "Cash", type: "ASSET" },
      { group_id, code: "1100", name: "Loans Receivable", type: "ASSET" },
      { group_id, code: "4000", name: "Interest Income", type: "INCOME" },
      { group_id: groups[1].id, code: "1000", name: "Cash", type: "ASSET" },
    ]).returning("id");
    const header = { group_id, type: "LOAN_PAYMENT", amount: "1100.00" };
    const post = (lines) => db.transaction(async (trx) => {
      const [transaction] = await trx("transactions").insert(header).returning("id");
      await trx("transaction_entries").insert(lines.map(line => ({
        group_id, transaction_id: transaction.id, ...line,
      })));
      return transaction.id;
    });
    const lines = [
      { account_id: cash.id, debit: "1100.00" },
      { account_id: loans.id, credit: "1000.00" },
      { account_id: interest.id, credit: "100.00" },
    ];
    const id = await post(lines);
    assert.equal((await db("transaction_entries").where({ transaction_id: id })).length, 3);
    await assert.rejects(post(lines.slice(0, 2)), { code: "23514" });
    await assert.rejects(db("transactions").insert(header), { code: "23514" });
    await assert.rejects(post([{ ...lines[0], credit: "1.00" }, ...lines.slice(1)]), { code: "23514" });
    await assert.rejects(post([{ ...lines[0], debit: "NaN" }, ...lines.slice(1)]), { code: "23514" });
    await assert.rejects(post([{ ...lines[0], account_id: otherCash.id }, ...lines.slice(1)]), { code: "23503" });
    await assert.rejects(db("transaction_entries").where({ transaction_id: id, account_id: interest.id })
      .update({ credit: "99.00" }), { code: "23514" });
    await assert.rejects(db("transaction_entries").where({ transaction_id: id }).del(), { code: "23514" });
    await assert.rejects(db("accounts").where({ id: cash.id }).del(), error =>
      ["23503", "23001"].includes(error.code) && error.constraint === "transaction_entries_group_account_fk");
    assert.equal((await db("transactions").where({ group_id })).length, 1);
    const { rows } = await db.raw(`SELECT relname FROM pg_class
      WHERE relname IN ('accounts', 'transaction_entries') AND relrowsecurity`);
    assert.equal(rows.length, 2);
  });

  const registration = { firstname: "Ana", lastname: "Cruz", groupName: "New Group", slug: "new-group", role: "AUDITOR" };
  const authId = "11111111-1111-4111-8111-111111111111";
  await db("auth.users").insert({ id: authId, phone: "639171234567",
    raw_user_meta_data: { comsca_registration: registration } });
  const profile = await db("users").where({ auth_user_id: authId }).first();
  assert.equal(profile.first_name, "Ana");
  assert.equal(profile.role, "OWNER");
  assert.equal(profile.family_name, "Cruz");
  assert.equal(profile.phone, "+639171234567");
  assert.equal(profile.password, null);
  assert.equal(profile.username, null);
  assert.equal(profile.email, null);
  const group = await db("groups").where({ id: profile.group_id }).first();
  assert.equal(group.name, "New Group");
  assert.equal(group.slug, "new-group");
  const duplicateId = "22222222-2222-4222-8222-222222222222";
  await assert.rejects(db("auth.users").insert({ id: duplicateId, phone: "639181234567",
    raw_user_meta_data: { comsca_registration: registration } }), { code: "23505" });
  assert.equal(await db("auth.users").where({ id: duplicateId }).first(), undefined);
  await assert.rejects(db.transaction(async (trx) => {
    await trx("auth.users").insert({ id: duplicateId, phone: "639181234567",
      raw_user_meta_data: { comsca_registration: { ...registration, slug: "rolled-back" } } });
    throw new Error("Simulated Auth/SMS failure");
  }), /Simulated Auth/);
  assert.equal(await db("groups").where({ slug: "rolled-back" }).first(), undefined);
  assert.equal(await db("users").where({ auth_user_id: duplicateId }).first(), undefined);
  await assert.rejects(db("auth.users").insert({ id: duplicateId, phone: "639181234567",
    raw_user_meta_data: { comsca_registration: { ...registration, firstname: {}, slug: "invalid" } } }), { code: "22023" });
  // Client-editable Auth metadata must never move a registered user to another group.
  await db("auth.users").where({ id: authId }).update({ raw_user_meta_data: {
    comsca_registration: { ...registration, slug: "beta", group_id: groups[1].id },
  } });
  assert.equal((await db("users").where({ auth_user_id: authId }).first()).group_id, profile.group_id);
  assert.equal((await db("users").where({ auth_user_id: authId }).first()).role, "OWNER");

  await t.test("member Auth linking is atomic, confirmed, group scoped, and ignores public metadata", async () => {
    const [target] = await db("users").insert({ group_id: group.id, first_name: "Login", family_name: "Member", phone: "+639191234567" }).returning("id");
    const member = { user_id: String(target.id), group_id: String(group.id), actor_id: String(profile.id) };
    const provisionId = "33333333-3333-4333-8333-333333333333";
    const row = { id: provisionId, phone: "639191234567", phone_confirmed_at: new Date(), raw_app_meta_data: { comsca_member: member } };
    for (const invalid of [
      { ...row, phone_confirmed_at: null },
      { ...row, phone: "639181234567" },
      { ...row, raw_app_meta_data: { comsca_member: { ...member, group_id: String(groups[0].id) } } },
      { ...row, raw_app_meta_data: { comsca_member: { ...member, actor_id: String(target.id) } } },
    ]) {
      await assert.rejects(db("auth.users").insert(invalid), { code: "23514" });
      assert.equal(await db("auth.users").where({ id: provisionId }).first(), undefined);
      assert.equal((await db("users").where({ id: target.id }).first()).auth_user_id, null);
    }
    // Client-editable metadata must not link a member to a login identity.
    await db("auth.users").insert({ id: provisionId, phone: row.phone, raw_user_meta_data: { comsca_member: member } });
    assert.equal((await db("users").where({ id: target.id }).first()).auth_user_id, null);
    await db("auth.users").where({ id: provisionId }).del();
    // Match Auth's multi-statement create/confirm flow; linkage runs at commit.
    await db.transaction(async trx => {
      await trx("auth.users").insert({ id: provisionId, phone: row.phone });
      await trx("auth.users").where({ id: provisionId }).update({ raw_app_meta_data: row.raw_app_meta_data, phone_confirmed_at: row.phone_confirmed_at });
    });
    assert.equal((await db("users").where({ id: target.id }).first()).auth_user_id, provisionId);
    const anotherId = "44444444-4444-4444-8444-444444444444";
    await assert.rejects(db("auth.users").insert({ ...row, id: anotherId }), { code: "23514" });
    assert.equal(await db("auth.users").where({ id: anotherId }).first(), undefined);
    // Remove this test's fixture so the later list checks retain their expected size.
    await db("users").where({ id: target.id }).del();
    await db("auth.users").where({ id: provisionId }).del();
  });

  await t.test("group user listing includes only current-cycle memberships within the group", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const list = async () => {
      const response = await handler({ version: "2.0", rawPath: "/groups/users", rawQueryString: "",
        headers: { authorization: "Bearer verified-token", "x-group-slug": group.slug },
        requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
      assert.equal(response.statusCode, 200);
      return JSON.parse(response.body);
    };
    const noCycle = await list();
    assert.equal(noCycle.current_cycle_id, null);
    assert.equal(noCycle.users[0].is_current_cycle_member, false);
    const [member] = await db("users").insert({ group_id: group.id, first_name: "Other", family_name: "Member" }).returning("id");
    // A newer historical row must not replace the actual current cycle.
    const cycles = await db("cycles").insert([
      { group_id: group.id, status: "closed", created_at: "2026-10-01T00:00:00Z" },
      { group_id: group.id, status: "draft", created_at: "2026-09-01T00:00:00Z" },
    ]).returning("id");
    await db("cycles").insert({ group_id: groups[1].id, created_at: "2026-10-01T00:00:00Z" });
    await db("cycle_members").insert([
      { cycle_id: cycles[0].id, user_id: member.id },
      { cycle_id: cycles[0].id, user_id: profile.id },
      { cycle_id: cycles[1].id, user_id: profile.id },
    ]);
    // No WHERE clauses: RLS must independently isolate all three tables.
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      assert.deepEqual(await trx("users").select("id"), []);
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(group.id)]);
      assert.equal((await trx("users").select("group_id")).every(row => row.group_id === group.id), true);
      assert.equal((await trx("cycles").select("group_id")).every(row => row.group_id === group.id), true);
      assert.equal((await trx("cycle_members").select("user_id")).length, 3);
      assert.deepEqual(await trx("users").select("id").where({ group_id: groups[1].id }), []);
    });
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(group.id)]);
      await trx("users").select("password");
    }), { code: "42501" });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      for (const table of ["users", "cycles", "cycle_members"]) {
        assert.deepEqual(await trx(table).select(table === "cycle_members" ? "user_id" : "id"), []);
      }
    });
    const result = await list();
    assert.equal(result.current_cycle_id, cycles[1].id);
    assert.equal(result.users.length, 2);
    assert.equal(result.users.find(user => user.id === profile.id).is_current_cycle_member, true);
    assert.equal(result.users.find(user => user.id === member.id).is_current_cycle_member, false);
    for (const user of result.users) {
      assert.equal(user.group_id, group.id);
      assert.equal("password" in user, false);
      assert.equal("auth_user_id" in user, false);
    }
    for (const status of ["active", "distributing"]) {
      await db("cycles").where({ id: cycles[1].id }).update({ status });
      assert.equal((await list()).current_cycle_id, cycles[1].id);
    }
    await db("cycles").where({ id: cycles[1].id }).update({ status: "closed" });
    const onlyHistory = await list();
    assert.equal(onlyHistory.current_cycle_id, null);
    assert.equal(onlyHistory.users.every(user => !user.is_current_cycle_member), true);
  });

  await t.test("POST /user persists a member only in the caller's managed group", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const postMember = async (slug) => {
      const result = await handler({ version: "2.0", rawPath: "/user", rawQueryString: "",
        headers: { "content-type": "application/json", authorization: "Bearer verified-token", "x-group-slug": slug },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
        body: JSON.stringify({ firstname: "New", lastname: "Member", username: "new-member" }),
        isBase64Encoded: false }, {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    assert.equal((await postMember("alpha")).status, 403);
    const created = await postMember(group.slug);
    assert.equal(created.status, 201);
    const member = await db("users").where({ id: created.body.user.id }).first();
    assert.equal(member.group_id, group.id);
    assert.equal(member.role, "MEMBER");
    assert.equal(member.auth_user_id, null);
    assert.equal(member.password, null);
    assert.equal((await postMember(group.slug)).status, 409);
    await db("users").where({ id: profile.id }).update({ role: "MEMBER" });
    assert.equal((await postMember(group.slug)).status, 403);
    await db("users").where({ id: profile.id }).update({ role: "OWNER" });
  });
  await t.test("POST /cycles creates only the sole draft, and authorizes against committed roles", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const post = async (body, slug = group.slug) => {
      const response = await handler({ version: "2.0", rawPath: "/cycles", rawQueryString: "",
        headers: { "content-type": "application/json", authorization: "Bearer verified-token", "x-group-slug": slug },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
        body: JSON.stringify(body), isBase64Encoded: false }, {});
      return { status: response.statusCode, body: JSON.parse(response.body) };
    };
    assert.equal((await post({}, "alpha")).status, 403);
    for (const status of ["inactive", "active", "distributing", "closed"]) {
      assert.equal((await post({ status })).status, 400);
    }
    const created = await post({ interest_rate: "2.500000", interest_period: "MONTHLY",
      interest_method: "COMPOUND", cost_per_share: "9999999999999999.99" });
    assert.equal(created.status, 201);
    const cycle = await db("cycles").where({ id: created.body.cycle.id }).first();
    assert.equal(cycle.group_id, group.id);
    assert.equal(cycle.interest_rate, "2.500000");
    assert.equal(cycle.cost_per_share, "9999999999999999.99");
    assert.equal(cycle.status, "draft");
    assert.equal(created.body.cycle.created_at, cycle.created_at.toISOString());
    assert.equal(created.body.cycle.updated_at, cycle.updated_at.toISOString());
    for (const status of ["draft", "active", "distributing"]) {
      await db("cycles").where({ id: cycle.id }).update({ status });
      assert.equal((await post({})).status, 409);
    }
    await db("cycles").where({ id: cycle.id }).update({ status: "closed" });
    await db("users").where({ id: profile.id }).update({ role: "ADMIN" });
    const draft = await post({});
    assert.equal(draft.status, 201);
    assert.equal(draft.body.cycle.status, "draft");
    await db("cycles").where({ id: draft.body.cycle.id }).update({ status: "closed" });

    const locker = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    const { rows: [{ pid }] } = await db.raw("SELECT pg_backend_pid() AS pid");
    const before = await db("cycles").where({ group_id: group.id }).count("id as count").first();
    const revocation = await locker.transaction();
    let pending;
    try {
      await revocation("users").where({ id: profile.id }).update({ role: "MEMBER" });
      pending = post({});
      await waitForLocks(revocation, [pid]);
      await revocation.commit();
      assert.equal((await pending).status, 403);
      assert.deepEqual(await db("cycles").where({ group_id: group.id }).count("id as count").first(), before);
    } finally {
      if (!revocation.isCompleted()) await revocation.rollback();
      if (pending) await pending;
      await locker.destroy();
    }
    await db("users").where({ id: profile.id }).update({ role: "OWNER" });
  });

  await t.test("PATCH /cycles edits only the current draft, completes its lifecycle, and freezes history", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const patch = async (id, body, slug = group.slug) => {
      const response = await handler({ version: "2.0", rawPath: `/cycles/${id}`, rawQueryString: "",
        headers: { "content-type": "application/json", authorization: "Bearer verified-token", "x-group-slug": slug },
        requestContext: { http: { method: "PATCH", sourceIp: "127.0.0.1" } },
        body: JSON.stringify(body), isBase64Encoded: false }, {});
      return { status: response.statusCode, body: JSON.parse(response.body) };
    };
    const [target] = await db("cycles").insert({ group_id: group.id, interest_rate: "2.500000",
      interest_period: "MONTHLY", interest_method: "COMPOUND", cost_per_share: "100.00",
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }).returning("*");
    const [foreign] = await db("cycles").insert({ group_id: groups[0].id, status: "closed" }).returning("id");
    assert.equal((await patch(foreign.id, { cost_per_share: "200" })).status, 404);
    assert.equal((await patch(target.id, { cost_per_share: "200" }, "alpha")).status, 403);
    await db("users").where({ id: profile.id }).update({ role: "ADMIN" });
    const edited = await patch(target.id, { interest_rate: "3.500000" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.cycle.interest_rate, "3.500000");
    assert.equal(edited.body.cycle.interest_period, "MONTHLY");
    assert.equal(edited.body.cycle.cost_per_share, "100.00");
    assert.equal(edited.body.cycle.created_at, target.created_at.toISOString());
    assert.notEqual(edited.body.cycle.updated_at, target.updated_at.toISOString());
    const unchangedDraft = await db("cycles").where({ id: target.id }).first();
    assert.equal((await patch(target.id, { status: "draft" })).status, 200);
    assert.deepEqual(await db("cycles").where({ id: target.id }).first(), unchangedDraft);
    assert.equal((await patch(target.id, { interest_rate: null })).status, 400);
    assert.equal((await patch(target.id, { status: "distributing" })).status, 409);
    assert.equal((await patch(target.id, { status: "closed" })).status, 409);
    assert.equal((await patch(target.id, { status: "active", cost_per_share: "200" })).status, 200);
    const active = await db("cycles").where({ id: target.id }).first();
    assert.equal((await patch(target.id, { status: "active" })).status, 200);
    assert.deepEqual(await db("cycles").where({ id: target.id }).first(), active);
    assert.equal((await patch(target.id, { status: "draft" })).status, 409);
    assert.equal((await patch(target.id, { status: "distributing", cost_per_share: "300" })).status, 409);
    assert.deepEqual(await db("cycles").where({ id: target.id }).first(), active);
    assert.equal((await patch(target.id, { status: "distributing" })).status, 200);
    for (const body of [{ status: "active" }, { status: "draft" }, { cost_per_share: "300" }]) {
      assert.equal((await patch(target.id, body)).status, 409);
    }
    const distributing = await db("cycles").where({ id: target.id }).first();
    assert.equal((await patch(target.id, { status: "distributing" })).status, 200);
    assert.deepEqual(await db("cycles").where({ id: target.id }).first(), distributing);
    assert.equal((await patch(target.id, { status: "closed" })).status, 200);
    const final = await db("cycles").where({ id: target.id }).first();
    const [newDraft] = await db("cycles").insert({ group_id: group.id }).returning("id");
    for (const body of [{ status: "draft" }, { status: "active" }, { status: "distributing" },
      { status: "closed" }, { cost_per_share: "300" }, {}]) {
      assert.equal((await patch(target.id, body)).status, 409);
    }
    assert.deepEqual(await db("cycles").where({ id: target.id }).first(), final);
    await db("cycles").where({ id: newDraft.id }).update({ status: "closed" });
    await db("users").where({ id: profile.id }).update({ role: "OWNER" });

    const locker = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    try {
      const [raceCycle] = await db("cycles").insert({ group_id: group.id, cost_per_share: "100.00" }).returning("id");
      for (const race of ["activation", "revocation", "financial-edit", "closure"]) {
        await db("users").where({ id: profile.id }).update({ role: "OWNER" });
        if (race !== "activation") await db("cycles").where({ id: raceCycle.id }).update({ status: "draft" });
        const { rows: [{ pid }] } = await db.raw("SELECT pg_backend_pid() AS pid");
        const writer = await locker.transaction();
        let pending;
        try {
          if (race === "activation" || race === "closure") {
            await writer("cycles").where({ id: raceCycle.id }).update({ status: race === "activation" ? "active" : "closed" });
          } else if (race === "revocation") {
            await writer("users").where({ id: profile.id }).update({ role: "MEMBER" });
          } else {
            await writer("cycles").where({ id: raceCycle.id }).update({ cost_per_share: "150" });
          }
          pending = patch(raceCycle.id, { cost_per_share: "200" });
          await waitForLocks(writer, [pid]);
          const { rows: [{ released_at }] } = await writer.raw("SELECT clock_timestamp() AS released_at");
          await writer.commit();
          const result = await pending;
          assert.equal(result.status, race === "revocation" ? 403 : race === "financial-edit" ? 200 : 409);
          assert.equal((await db("cycles").where({ id: raceCycle.id }).first()).cost_per_share,
            ["financial-edit", "closure"].includes(race) ? "200.00" : "100.00");
          if (race === "financial-edit") assert.ok(new Date(result.body.cycle.updated_at) >= released_at);
        } finally {
          if (!writer.isCompleted()) await writer.rollback();
          if (pending) await pending;
        }
      }
    } finally {
      await locker.destroy();
      await db("users").where({ id: profile.id }).update({ role: "OWNER" });
    }
  });

  await t.test("concurrent draft creation has one winner across different authorized profiles", async () => {
    const otherAuthId = "55555555-5555-4555-8555-555555555555";
    await db("auth.users").insert({ id: otherAuthId });
    const [other] = await db("users").insert({ auth_user_id: otherAuthId, group_id: group.id,
      first_name: "Another", family_name: "Admin", role: "ADMIN" }).returning("id");
    const connections = [0, 1].map(() => knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } }));
    const identities = [authId, otherAuthId];
    let gate;
    let pending = [];
    try {
      const pids = await Promise.all(connections.map(async connection =>
        (await connection.raw("SELECT pg_backend_pid() AS pid")).rows[0].pid));
      gate = await db.transaction();
      await gate("users").whereIn("id", [profile.id, other.id]).forUpdate().select("id");
      pending = connections.map((connection, i) => serverless(createApp(connection, {
        getUser: async () => ({ id: identities[i] }),
      }))({ version: "2.0", rawPath: "/cycles", rawQueryString: "",
        headers: { "content-type": "application/json", authorization: "Bearer verified-token", "x-group-slug": group.slug },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
        body: JSON.stringify({ cost_per_share: "200" }), isBase64Encoded: false }, {}));
      await waitForLocks(gate, pids);
      await gate.commit();
      const results = await Promise.all(pending);
      assert.deepEqual(results.map(result => result.statusCode).sort(), [201, 409]);
      const current = await db("cycles").where({ group_id: group.id }).where("status", "<>", "closed");
      assert.equal(current.length, 1);
      assert.equal(current[0].status, "draft");
      await db("cycles").where({ id: current[0].id }).update({ status: "closed" });
    } finally {
      if (gate && !gate.isCompleted()) await gate.rollback();
      await Promise.allSettled(pending);
      await Promise.all(connections.map(connection => connection.destroy()));
    }
  });
  await t.test("GET cycles uses RLS, identifies current independently of ordering, and restores grants", async () => {
    const [listGroup] = await db("groups").insert({ name: "Cycle listing", slug: "cycle-listing" }).returning("id");
    const listAuthId = "66666666-6666-4666-8666-666666666666";
    await db("auth.users").insert({ id: listAuthId });
    const [actor] = await db("users").insert({ auth_user_id: listAuthId, group_id: listGroup.id,
      first_name: "List", family_name: "Owner", role: "OWNER" }).returning("id");
    const handler = serverless(createApp(db, { getUser: async () => ({ id: listAuthId }) }));
    const list = async (path = "/api/v1/cycles") => {
      const result = await handler({ version: "2.0", rawPath: path, rawQueryString: `group_id=${groups[0].id}`,
        headers: { authorization: "Bearer verified-token", "x-group-slug": "cycle-listing" },
        requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    assert.deepEqual((await list()).body, { success: true, current_cycle_id: null, cycles: [] });
    const [current, older, newer] = await db("cycles").insert([
      { group_id: listGroup.id, status: "draft", created_at: "2026-09-01T00:00:00Z",
        interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "SIMPLE", cost_per_share: "9999999999999999.99" },
      { group_id: listGroup.id, status: "closed", created_at: "2026-10-01T00:00:00Z" },
      { group_id: listGroup.id, status: "closed", created_at: "2026-10-01T00:00:00Z" },
    ]).returning("id");
    for (const role of ["OWNER", "ADMIN"]) {
      await db("users").where({ id: actor.id }).update({ role });
      for (const route of ["/cycles", "/api/v1/cycles"]) {
        const result = await list(route);
        assert.equal(result.status, 200);
        assert.equal(result.body.current_cycle_id, current.id);
        assert.deepEqual(result.body.cycles.map(row => row.id), [newer.id, older.id, current.id]);
        assert.equal(result.body.cycles.every(row => row.group_id === listGroup.id), true);
        assert.equal(result.body.cycles[2].cost_per_share, "9999999999999999.99");
        const saved = await db("cycles").where({ group_id: listGroup.id }).orderBy("created_at", "desc").orderBy("id", "desc");
        assert.deepEqual(result.body.cycles, JSON.parse(JSON.stringify(saved)));
      }
    }
    for (const status of ["active", "distributing", "closed"]) {
      await db("cycles").where({ id: current.id }).update({ status });
      assert.equal((await list()).body.current_cycle_id, status === "closed" ? null : current.id);
    }
    // Omit the application group filter: RLS must still protect every granted column.
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(listGroup.id)]);
      const visible = await trx("cycles").select("group_id", "interest_rate", "interest_period", "interest_method", "cost_per_share", "updated_at");
      assert.equal(visible.length, 3);
      assert.equal(visible.every(row => row.group_id === listGroup.id), true);
    });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      assert.deepEqual(await trx("cycles").select("cost_per_share"), []);
    });
    await db.migrate.down(); // 013 only; original grants must survive.
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx("cycles").select("cost_per_share");
    }), { code: "42501" });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(listGroup.id)]);
      assert.equal((await trx("cycles").select("id", "group_id", "created_at", "status")).length, 3);
    });
    await db.migrate.latest();
    assert.equal((await list()).status, 200);
  });

});
