const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const knex = require("knex");
const path = require("node:path");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

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
    await db.migrate.latest();
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
    await db.migrate.latest();
    assert.equal((await db("cycles").whereIn("id", ids).select("status")).every(row => row.status === "inactive"), true);
    await db("cycles").whereIn("id", ids).del();
  });

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
    const [cycle] = await db("cycles").insert({ group_id }).returning("*");
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
    await db("cycles").insert({ group_id, cost_per_share: "50.00" });
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
    // Equal timestamps exercise the deterministic ID tie-breaker.
    const cycles = await db("cycles").insert([
      { group_id: group.id, created_at: "2026-09-01T00:00:00Z" },
      { group_id: group.id, created_at: "2026-09-01T00:00:00Z" },
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
  await t.test("POST /cycles persists settings, enforces group authorization and active conflicts", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const post = async (body, slug = group.slug) => {
      const response = await handler({ version: "2.0", rawPath: "/cycles", rawQueryString: "",
        headers: { "content-type": "application/json", authorization: "Bearer verified-token", "x-group-slug": slug },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
        body: JSON.stringify(body), isBase64Encoded: false }, {});
      return { status: response.statusCode, body: JSON.parse(response.body) };
    };
    assert.equal((await post({}, "alpha")).status, 403);
    const created = await post({ interest_rate: "2.500000", interest_period: "MONTHLY",
      interest_method: "COMPOUND", cost_per_share: "9999999999999999.99", status: "active" });
    assert.equal(created.status, 201);
    const cycle = await db("cycles").where({ id: created.body.cycle.id }).first();
    assert.equal(cycle.group_id, group.id);
    assert.equal(cycle.interest_rate, "2.500000");
    assert.equal(cycle.cost_per_share, "9999999999999999.99");
    assert.equal(cycle.status, "active");
    assert.equal(created.body.cycle.created_at, cycle.created_at.toISOString());
    assert.equal(created.body.cycle.updated_at, cycle.updated_at.toISOString());
    assert.equal((await post({ status: "active" })).status, 409);
    await db("users").where({ id: profile.id }).update({ role: "ADMIN" });
    const inactive = await post({});
    assert.equal(inactive.status, 201);
    assert.equal(inactive.body.cycle.status, "inactive");

    // A committed role revocation must take effect before an awaiting create.
    const locker = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    const { rows: [{ pid }] } = await db.raw("SELECT pg_backend_pid() AS pid");
    const before = await db("cycles").where({ group_id: group.id }).count("id as count").first();
    const revocation = await locker.transaction();
    try {
      await revocation("users").where({ id: profile.id }).update({ role: "MEMBER" });
      const pending = post({});
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await revocation.raw("SELECT cardinality(pg_blocking_pids(?)) > 0 AS blocked", [pid]);
        if (rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "Create must wait for role revocation");
      await revocation.commit();
      assert.equal((await pending).status, 403);
      assert.deepEqual(await db("cycles").where({ group_id: group.id }).count("id as count").first(), before);
    } finally {
      if (!revocation.isCompleted()) await revocation.rollback();
      await locker.destroy();
    }
    await db("users").where({ id: profile.id }).update({ role: "OWNER" });
  });

});
