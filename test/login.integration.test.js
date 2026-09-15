const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const knex = require("knex");
const path = require("node:path");
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
  // Rollback only the new migration, then prove it can be applied again.
  await db.migrate.down();
  await db.migrate.latest();

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
    await assert.rejects(db("accounts").where({ id: cash.id }).del(), { code: "23503" });
    assert.equal((await db("transactions").where({ group_id })).length, 1);
    const { rows } = await db.raw(`SELECT relname FROM pg_class
      WHERE relname IN ('accounts', 'transaction_entries') AND relrowsecurity`);
    assert.equal(rows.length, 2);
  });

  const registration = { firstname: "Ana", lastname: "Cruz", groupName: "New Group", slug: "new-group" };
  const authId = "11111111-1111-4111-8111-111111111111";
  await db("auth.users").insert({ id: authId, phone: "639171234567",
    raw_user_meta_data: { comsca_registration: registration } });
  const profile = await db("users").where({ auth_user_id: authId }).first();
  assert.equal(profile.first_name, "Ana");
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
});
