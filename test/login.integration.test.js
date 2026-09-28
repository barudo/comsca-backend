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
  // Legacy rollback scenarios below intentionally exercise migrations through 013.
  const allMigrations = db.client.config.migrations;
  const legacyMigrations = { migrationSource: {
    getMigrations: async () => require('node:fs').readdirSync(path.join(__dirname, '../migrations')).filter(name => name <= '013_zz'),
    getMigrationName: name => name,
    getMigration: name => require(path.join(__dirname, '../migrations', name)),
  } };
  db.client.config.migrations = legacyMigrations;
  await db.migrate.latest(legacyMigrations);
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
    await db.migrate.down(legacyMigrations); // Remove 013 column grants.
    await db.migrate.down(legacyMigrations); // Remove 012 before exercising the legacy migration.
    await db.migrate.down(legacyMigrations); // Remove 011 to exercise pre-existing rows.
    const existing = await db("cycles").insert([
      { group_id: groups[0].id, interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "SIMPLE", cost_per_share: "100.00" },
      { group_id: groups[0].id }, { group_id: groups[1].id },
    ]).returning("id");
    const ids = existing.map(row => row.id);
    const member = await db("users").where({ group_id: groups[0].id }).first("id");
    await db("cycle_members").insert({ cycle_id: ids[0], user_id: member.id });
    const before = await db("cycles").whereIn("id", ids).orderBy("id");
    const membership = await db("cycle_members").where({ cycle_id: ids[0] });
    await db.migrate.up({ ...legacyMigrations, name: "011_add_cycle_status.js" });
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
    await db.migrate.down(legacyMigrations);
    assert.equal(await db.schema.hasColumn("cycles", "status"), false);
    assert.equal((await db("cycles").whereIn("id", ids)).length, ids.length);
    assert.deepEqual(await db("cycles").whereIn("id", existing.map(row => row.id)).orderBy("id"), before);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: ids[0] }), membership);
    await db.migrate.up({ ...legacyMigrations, name: "011_add_cycle_status.js" });
    assert.equal((await db("cycles").whereIn("id", ids).select("status")).every(row => row.status === "inactive"), true);
    await db("cycles").whereIn("id", ids).del();
    await db.migrate.latest(legacyMigrations);
  });

  await t.test("current-cycle migration preserves history and blocks ambiguous ongoing groups atomically", async () => {
    await db.migrate.down(legacyMigrations); // Remove 013 column grants.
    await db.migrate.down(legacyMigrations); // 012: exercise actual legacy data under 011.
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
    await assert.rejects(db.migrate.latest(legacyMigrations), /multiple active\/distributing cycles/);
    assert.deepEqual(await db("cycles").orderBy("id"), before);
    assert.equal(await db("knex_migrations").where({ name: "012_current_cycle_lifecycle.js" }).first(), undefined);
    // Resolve only the deliberately conflicting test row, then retry.
    await db("cycles").where({ id: conflict.id }).del();
    await db.migrate.latest(legacyMigrations);
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
    await db.migrate.down(legacyMigrations); // Remove 013 column grants.
    await db.migrate.down(legacyMigrations);
    assert.equal((await db("cycles").where({ id: draft.id }).first()).status, "inactive");
    assert.deepEqual(await db("cycles").where({ id: legacy.id }).first(), legacy);
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx("cycles").select("status");
    }), { code: "42501" });
    await db.migrate.latest(legacyMigrations);
    assert.equal((await db("cycles").where({ id: draft.id }).first()).status, "closed");
    assert.deepEqual(await db("cycle_members").where({ cycle_id: legacy.id }), memberships);
    await db("cycles").whereIn("id", [legacy.id, active.id, distributing.id]).del();
    await db("groups").where({ id: emptyGroup.id }).del();
  });

  await db.migrate.down(legacyMigrations); // Cycle list column grants
  await db.migrate.down(legacyMigrations); // Current-cycle lifecycle
  await db.migrate.down(legacyMigrations); // Cycle status
  await db.migrate.down(legacyMigrations); // Group reader RLS
  // Roll back provisioning and roles, then prove both can be applied again.
  await db.migrate.down(legacyMigrations);
  await db.migrate.down(legacyMigrations);
  assert.equal(await db.schema.hasColumn("users", "role"), false);
  await db.migrate.latest(legacyMigrations);

  db.client.config.migrations = allMigrations;
  await db.migrate.latest({ ...allMigrations, migrationSource: null });

  await t.test("cycle document counters default, validate and roll back", async () => {
    const migration = require("../migrations/022_add_cycle_document_counters");
    const counterRead = require("../migrations/024_allow_cycle_document_counters_read");
    const fields = ["receipt_counter", "disbursement_voucher_counter", "journal_voucher_counter"];
    const [cycle] = await db("cycles").insert({ group_id: groups[0].id, status: "closed" }).returning("*");
    for (const field of fields) assert.equal(cycle[field], "0");
    await db.transaction(trx => counterRead.down(trx));
    await db.transaction(trx => migration.down(trx));
    for (const field of fields) assert.equal(await db.schema.hasColumn("cycles", field), false);
    const before = await db("cycles").where({ id: cycle.id }).first();
    await db.transaction(trx => migration.up(trx));
    await db.transaction(trx => counterRead.up(trx));
    assert.deepEqual(await db("cycles").where({ id: cycle.id }).first(), {
      ...before, receipt_counter: "0", disbursement_voucher_counter: "0", journal_voucher_counter: "0",
    });
    for (const field of fields) {
      await assert.rejects(db("cycles").where({ id: cycle.id }).update({ [field]: -1 }), { code: "23514" });
      await assert.rejects(db("cycles").where({ id: cycle.id }).update({ [field]: null }), { code: "23502" });
      await db("cycles").where({ id: cycle.id }).increment(field, 1);
    }
    const saved = await db("cycles").where({ id: cycle.id }).first();
    for (const field of fields) assert.equal(saved[field], "1");
    await db("cycles").where({ id: cycle.id }).update({ receipt_counter: "2147483648" });
    assert.equal((await db("cycles").where({ id: cycle.id }).first()).receipt_counter, "2147483648");
    const [next] = await db("cycles").insert({ group_id: groups[0].id, status: "closed" }).returning("*");
    for (const field of fields) assert.equal(next[field], "0");
  });

  await t.test("transaction document numbers validate and isolate numbering scopes", async () => {
    const [group] = await db("groups").insert({ name: "Documents", slug: "documents" }).returning("id");
    const cycles = await db("cycles").insert([
      { group_id: group.id, status: "closed" }, { group_id: group.id, status: "closed" },
    ]).returning("id");
    const accounts = await db("accounts").insert([
      { group_id: group.id, code: "cash", name: "Cash", type: "ASSET" },
      { group_id: group.id, code: "equity", name: "Equity", type: "EQUITY" },
    ]).returning("id");
    const post = (document, cycle_id = cycles[0].id) => db.transaction(async trx => {
      const [header] = await trx("transactions").insert({ group_id: group.id, cycle_id,
        type: "EQUITY", amount: "1.00", ...document }).returning("*");
      const [component] = await trx("transaction_entries").insert({ group_id: group.id,
        transaction_id: header.id, type: "EQUITY", amount: "1.00" }).returning("id");
      await trx("account_entries").insert(accounts.map((account, i) => ({ group_id: group.id,
        transaction_entry_id: component.id, account_id: account.id, amount: i ? "-1.00" : "1.00" })));
      return header;
    });
    const receipt = { document_type: "RECEIPT", document_number: "1" };
    const original = await post(receipt);
    await assert.rejects(post(receipt), { code: "23505" });
    await post(receipt, cycles[1].id);
    await post({ document_type: "DISBURSEMENT_VOUCHER", document_number: "1" });
    await post({ document_type: "JOURNAL_VOUCHER", document_number: "1" });
    await post(receipt, null);
    await assert.rejects(post(receipt, null), { code: "23505" });
    for (const document of [ { document_type: "RECEIPT" }, { document_number: "1" },
      { document_type: "OTHER", document_number: "1" }, { ...receipt, document_number: "0" },
      { ...receipt, document_number: "-1" } ]) {
      await assert.rejects(post(document), { code: "23514" });
    }
    await post({}); await post({});
    const large = await post({ ...receipt, document_number: "2147483648" });
    assert.equal(large.document_number, "2147483648");
    await assert.rejects(db("transactions").where({ id: large.id }).update(receipt), { code: "23505" });
    assert.equal((await db("transactions").where({ id: original.id }).first()).document_number, "1");
    // Exercise rollback/reapplication on this disposable fixture only.
    const migration = require("../migrations/023_add_transaction_document_numbers");
    await db.transaction(trx => migration.down(trx));
    assert.equal(await db.schema.hasColumn("transactions", "document_number"), false);
    await db.transaction(trx => migration.up(trx));
    const preserved = await db("transactions").where({ id: original.id }).first();
    assert.equal(preserved.amount, "1.00");
    assert.equal(preserved.document_type, null); assert.equal(preserved.document_number, null);
  });

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

  await t.test("accounting enforces component totals, signed postings and group boundaries", async () => {
    const group_id = groups[0].id;
    const [cash, loans, penalty, otherCash] = await db("accounts").insert([
      { group_id, code: "1000", name: "Cash", type: "ASSET" },
      { group_id, code: "1100", name: "Loans Receivable", type: "ASSET" },
      { group_id, code: "4100", name: "Penalty Income", type: "INCOME" },
      { group_id: groups[1].id, code: "1000", name: "Cash", type: "ASSET" },
    ]).returning("id");
    const header = { group_id, type: "LOAN_PAYMENT", amount: "1100.00" };
    const post = (debitAccount = cash.id, principal = "1000.00") => db.transaction(async trx => {
      const [transaction] = await trx("transactions").insert(header).returning("id");
      for (const [type, amount, account] of [["PRINCIPAL", principal, loans.id], ["PENALTY", "100.00", penalty.id]]) {
        const [component] = await trx("transaction_entries").insert({ group_id, transaction_id: transaction.id, type, amount }).returning("id");
        await trx("account_entries").insert([
          { group_id, transaction_entry_id: component.id, account_id: debitAccount, amount },
          { group_id, transaction_entry_id: component.id, account_id: account, amount: `-${amount}` },
        ]);
      }
      return transaction.id;
    });
    const id = await post();
    const components = await db("transaction_entries").where({ transaction_id: id }).orderBy("id");
    assert.deepEqual(components.map(({ type, amount }) => ({ type, amount })), [
      { type: "PRINCIPAL", amount: "1000.00" }, { type: "PENALTY", amount: "100.00" },
    ]);
    await assert.rejects(post(cash.id, "999.00"), { code: "23514" });
    await assert.rejects(post(otherCash.id), { code: "23503" });
    await assert.rejects(db("transactions").insert(header), { code: "23514" });
    await assert.rejects(db("account_entries").where({ transaction_entry_id: components[0].id, account_id: cash.id }).update({ amount: "999.00" }), { code: "23514" });
    await assert.rejects(db("account_entries").where({ transaction_entry_id: components[0].id }).del(), { code: "23514" });
    await assert.rejects(db("transaction_entries").where({ id: components[0].id }).update({ amount: "NaN" }), { code: "23514" });
    await assert.rejects(db("accounts").where({ id: cash.id }).del(), error => ["23503", "23001"].includes(error.code));
    const { rows } = await db.raw(`SELECT relname FROM pg_class WHERE relname IN ('accounts','transaction_entries','account_entries') AND relrowsecurity`);
    assert.equal(rows.length, 3);
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
      const response = await handler({ version: "2.0", rawPath: "/api/v1/groups/users", rawQueryString: "",
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

  await t.test("POST /api/v1/user persists a member only in the caller's managed group", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const postMember = async (slug) => {
      const result = await handler({ version: "2.0", rawPath: "/api/v1/user", rawQueryString: "",
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
  await t.test("POST /api/v1/cycles creates only the sole draft, and authorizes against committed roles", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const post = async (body, slug = group.slug) => {
      const response = await handler({ version: "2.0", rawPath: "/api/v1/cycles", rawQueryString: "",
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

  await t.test("PATCH /api/v1/cycles edits only the current draft, completes its lifecycle, and freezes history", async () => {
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const patch = async (id, body, slug = group.slug) => {
      const response = await handler({ version: "2.0", rawPath: `/api/v1/cycles/${id}`, rawQueryString: "",
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
      }))({ version: "2.0", rawPath: "/api/v1/cycles", rawQueryString: "",
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
  await t.test("POST payments persists balanced postings and rolls back failures", async () => {
    const [group] = await db("groups").insert({ name: "Equity", slug: "equity-posting" }).returning("id");
    const authId = "88888888-8888-4888-8888-888888888888";
    await db("auth.users").insert({ id: authId });
    const [actor, member] = await db("users").insert([
      { auth_user_id: authId, group_id: group.id, first_name: "Equity", family_name: "Treasurer", role: "TREASURER" },
      { group_id: group.id, first_name: "Equity", family_name: "Member", role: "MEMBER" },
    ]).returning("id");
    const [cycle] = await db("cycles").insert({ group_id: group.id, status: "active" }).returning("id");
    await db("cycle_members").insert({ cycle_id: cycle.id, user_id: member.id });
    const accounts = await db("accounts").where({ cycle_id: cycle.id });
    const cash = accounts.find(a => a.code === "1000");
    const equity = accounts.find(a => a.code === "3000");
    const input = { debit: cash.id, credit: equity.id, amount: "9999999999999999.99", user_id: member.id };
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const paymentBody = body => body.entries ? body : {
      user_id: body.user_id, cycle_id: body.cycle_id, description: body.description,
      entries: [{ type: "BUY_SHARE", debit: body.debit, credit: body.credit, amount: body.amount }],
    };
    const post = async (body = input, slug = "equity-posting") => {
      const result = await handler({ version: "2.0", rawPath: "/api/v1/transactions/payments", rawQueryString: "group_id=999",
        headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": slug },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: JSON.stringify(paymentBody(body)), isBase64Encoded: false }, {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    const result = await post();
    assert.equal(result.status, 201);
    const header = result.body.transaction;
    assert.equal(header.cycle_id, cycle.id); assert.equal(header.user_id, member.id);
    assert.equal(header.amount, input.amount); assert.equal(header.type, "PAYMENT");
    assert.deepEqual(JSON.parse(JSON.stringify(await db("transactions").where({ id: header.id }).first())), { ...header, document_type: null, document_number: null });
    const components = await db("transaction_entries").where({ transaction_id: header.id });
    assert.equal(components.length, 1); assert.equal(components[0].type, "BUY_SHARE"); assert.equal(components[0].amount, input.amount);
    const postings = await db("account_entries").where({ transaction_entry_id: components[0].id }).orderBy("id");
    assert.deepEqual(postings.map(p => [p.account_id, p.amount]), [[cash.id, input.amount], [equity.id, `-${input.amount}`]]);
    assert.equal((await post({ ...input, credit: cash.id })).status, 400);
    assert.equal((await post({ ...input, credit: accounts.find(a => a.type === "INCOME").id })).status, 400);
    const loans = accounts.find(a => a.code === "1100");
    const penalties = accounts.find(a => a.code === "1300");
    const mixedInput = {
      user_id: member.id, description: "Member payment",
      entries: [
        { type: "BUY_SHARE", debit: cash.id, credit: equity.id, amount: "0.10" },
        { type: "LOAN_PAYMENT", debit: cash.id, credit: loans.id, amount: "0.20", description: "Principal and interest together" },
        { type: "PENALTY_PAYMENT", debit: cash.id, credit: penalties.id, amount: "0.30" },
      ],
    };
    const mixed = await post(mixedInput);
    assert.equal(mixed.status, 201);
    assert.equal(mixed.body.transaction.type, "PAYMENT");
    assert.equal(mixed.body.transaction.amount, "0.60");
    assert.equal(mixed.body.transaction.user_id, member.id);
    assert.equal(mixed.body.transaction.cycle_id, cycle.id);
    const mixedComponents = await db("transaction_entries").where({ transaction_id: mixed.body.transaction.id }).orderBy("id");
    assert.deepEqual(mixedComponents.map(entry => [entry.type, entry.amount]),
      [["BUY_SHARE", "0.10"], ["LOAN_PAYMENT", "0.20"], ["PENALTY_PAYMENT", "0.30"]]);
    for (const [index, component] of mixedComponents.entries()) {
      const rows = await db("account_entries").where({ transaction_entry_id: component.id }).orderBy("id");
      assert.deepEqual(rows.map(row => [row.account_id, row.amount]),
        [[cash.id, component.amount], [mixedInput.entries[index].credit, `-${component.amount}`]]);
    }
    assert.equal((await post({ ...mixedInput, entries: [
      { ...mixedInput.entries[0], amount: input.amount }, mixedInput.entries[1],
    ] })).status, 400);
    const penaltyIncome = accounts.find(account => account.code === "4100");
    const maximumBatch = await post({ user_id: member.id, entries: Array.from({ length: 100 }, () =>
      ({ type: "BUY_SHARE", debit: cash.id, credit: equity.id, amount: "0.01" })) });
    assert.equal(maximumBatch.status, 201);
    assert.equal(maximumBatch.body.transaction.amount, "1.00");
    assert.equal(maximumBatch.body.entries.length, 100);
    assert.equal(maximumBatch.body.account_entries.length, 200);
    const immediatePenalty = await post({ user_id: member.id,
      entries: [{ type: "PENALTY_PAYMENT", debit: cash.id, credit: penaltyIncome.id, amount: "1.00" }],
    });
    assert.equal(immediatePenalty.status, 201);
    const [penaltyComponent] = await db("transaction_entries").where({ transaction_id: immediatePenalty.body.transaction.id });
    const penaltyPostings = await db("account_entries").where({ transaction_entry_id: penaltyComponent.id }).orderBy("id");
    assert.deepEqual(penaltyPostings.map(row => [row.account_id, row.amount]), [[cash.id, "1.00"], [penaltyIncome.id, "-1.00"]]);
    const other = await db("accounts").whereNot({ group_id: group.id }).first("id");
    assert.equal((await post({ ...input, debit: other.id })).status, 404);
    assert.equal((await post(input, "alpha")).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "AUDITOR" });
    assert.equal((await post()).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "OWNER" });
    const [nonmember] = await db("users").insert({ group_id: group.id, first_name: "Not", family_name: "Enrolled" }).returning("id");
    assert.equal((await post({ ...input, user_id: nonmember.id })).status, 400);
    await db("cycles").where({ id: cycle.id }).update({ status: "closed" });
    assert.equal((await post({ ...input, amount: "0.01" })).status, 201);
    const [groupCash, groupEquity] = await db("accounts").insert([
      { group_id: group.id, code: "cash", name: "Group Cash", type: "ASSET" },
      { group_id: group.id, code: "equity", name: "Group Equity", type: "EQUITY" },
    ]).returning("id");
    const groupPost = await post({ debit: groupCash.id, credit: groupEquity.id, amount: 500 });
    assert.equal(groupPost.status, 400);
    assert.equal((await post({ debit: groupCash.id, credit: groupEquity.id, amount: 500, user_id: member.id })).status, 400);
    // Explicit cycle and mixed group/cycle account directions preserve attribution.
    for (const pair of [
      { debit: cash.id, credit: equity.id },
      { debit: groupCash.id, credit: equity.id },
      { debit: cash.id, credit: groupEquity.id },
      { debit: groupCash.id, credit: groupEquity.id },
    ]) {
      const explicit = await post({ ...pair, amount: "0.01", cycle_id: cycle.id, user_id: member.id });
      assert.equal(explicit.status, 201);
      assert.equal(explicit.body.transaction.cycle_id, cycle.id);
      assert.equal(explicit.body.transaction.user_id, member.id);
    }
    const foreignUser = await db("users").whereNot({ group_id: group.id }).first("id");
    assert.equal((await post({ ...input, user_id: foreignUser.id })).status, 404);
    const foreignCycle = await db("cycles").whereNot({ group_id: group.id }).first("id");
    assert.equal((await post({ debit: groupCash.id, credit: groupEquity.id, amount: "1.00", cycle_id: foreignCycle.id, user_id: member.id })).status, 404);
    // A writer waits on locked authorization/reference rows and sees their committed changes.
    const connection = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    const concurrentHandler = serverless(createApp(connection, { getUser: async () => ({ id: authId }) }));
    try {
      const { rows: [{ pid }] } = await connection.raw("SELECT pg_backend_pid() AS pid");
      for (const change of [
        { table: "users", id: actor.id, value: { role: "AUDITOR" }, restore: { role: "OWNER" }, status: 403 },
        { table: "accounts", id: cash.id, value: { type: "INCOME" }, restore: { type: "ASSET" }, status: 400 },
        { table: "accounts", id: loans.id, value: { code: "1101" }, restore: { code: "1100" }, status: 400 },
      ]) {
        const gate = await db.transaction();
        let pending;
        try {
          await gate(change.table).where({ id: change.id }).update(change.value);
          pending = concurrentHandler({ version: "2.0", rawPath: "/api/v1/transactions/payments", rawQueryString: "",
            headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "equity-posting" },
            requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
            body: JSON.stringify(mixedInput), isBase64Encoded: false }, {});
          await waitForLocks(gate, [pid]);
          await gate.commit();
          assert.equal((await pending).statusCode, change.status);
        } finally {
          if (!gate.isCompleted()) await gate.rollback();
          if (pending) await pending;
          await db(change.table).where({ id: change.id }).update(change.restore);
        }
      }
    } finally { await connection.destroy(); }
    const counts = async () => Promise.all(["transactions", "transaction_entries", "account_entries"].map(async table =>
      (await db(table).where({ group_id: group.id }).count("* as count").first()).count));
    const before = await counts();
    await db.raw(`CREATE FUNCTION public.reject_test_equity_credit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.amount < 0 AND NEW.account_id = ${loans.id} THEN RAISE EXCEPTION 'Test posting rejection' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_equity_credit_failure BEFORE INSERT ON public.account_entries
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_equity_credit();`);
    try {
      const failed = await post(mixedInput);
      assert.equal(failed.status, 409);
      assert.doesNotMatch(failed.body.error, /Test posting rejection/);
      assert.deepEqual(await counts(), before);
      await db.raw(`DROP TRIGGER test_equity_credit_failure ON public.account_entries;
        CREATE CONSTRAINT TRIGGER test_equity_credit_failure AFTER INSERT ON public.account_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_test_equity_credit();`);
      const commitFailure = await post(mixedInput);
      assert.equal(commitFailure.status, 409);
      assert.doesNotMatch(commitFailure.body.error, /Test posting rejection/);
      assert.deepEqual(await counts(), before);

    } finally {
      await db.raw("DROP TRIGGER test_equity_credit_failure ON public.account_entries; DROP FUNCTION public.reject_test_equity_credit()");
    }
  });
  await t.test("POST loan disbursements persist balanced postings and roll back failures", async () => {
    const [group] = await db("groups").insert({ name: "Loan Disbursement", slug: "loan-disbursement" }).returning("id");
    const authId = "abababab-abab-4bab-8bab-abababababab";
    await db("auth.users").insert({ id: authId });
    const [actor, member, unenrolled] = await db("users").insert([
      { auth_user_id: authId, group_id: group.id, first_name: "Loan", family_name: "Treasurer", role: "TREASURER" },
      { group_id: group.id, first_name: "Loan", family_name: "Member", role: "MEMBER" },
      { group_id: group.id, first_name: "Unenrolled", family_name: "Member", role: "MEMBER" },
    ]).returning("id");
    const [cycle] = await db("cycles").insert({ group_id: group.id, status: "active" }).returning("id");
    await db("cycle_members").insert({ cycle_id: cycle.id, user_id: member.id });
    const accounts = await db("accounts").where({ cycle_id: cycle.id });
    const cash = accounts.find(account => account.code === "1000");
    const loans = accounts.find(account => account.code === "1100");
    const input = { user_id: member.id, debit: loans.id, credit: cash.id,
      amount: "9999999999999999.99", description: "Member loan disbursement" };
    const handler = serverless(createApp(db, { getUser: async () => ({ id: authId }) }));
    const event = (body, slug = "loan-disbursement") => ({ version: "2.0",
      rawPath: "/api/v1/transactions/disburse-loans", rawQueryString: "group_id=999",
      headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": slug },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
      body: JSON.stringify(body), isBase64Encoded: false });
    const post = async (body = input, slug) => {
      const response = await handler(event(body, slug), {});
      return { status: response.statusCode, body: JSON.parse(response.body) };
    };
    const result = await post();
    assert.equal(result.status, 201);
    const header = result.body.transaction;
    assert.equal(header.type, "LOAN_DISBURSED");
    assert.equal(header.amount, input.amount);
    assert.equal(header.user_id, member.id);
    assert.equal(header.cycle_id, cycle.id);
    assert.equal(header.description, input.description);
    const stored = await db("transactions").where({ id: header.id }).first();
    assert.equal(stored.amount, input.amount);
    assert.equal(stored.type, "LOAN_DISBURSED");
    const components = await db("transaction_entries").where({ transaction_id: header.id });
    assert.equal(components.length, 1);
    assert.equal(components[0].type, "LOAN_DISBURSED");
    assert.equal(components[0].amount, input.amount);
    const postings = await db("account_entries").where({ transaction_entry_id: components[0].id }).orderBy("id");
    assert.deepEqual(postings.map(row => [row.account_id, row.amount]),
      [[loans.id, input.amount], [cash.id, `-${input.amount}`]]);
    const explicit = await post({ ...input, cycle_id: cycle.id, amount: "0.01" });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.transaction.cycle_id, cycle.id);
    assert.equal((await post({ ...input, user_id: undefined })).status, 400);
    assert.equal((await post({ ...input, user_id: unenrolled.id })).status, 400);
    assert.equal((await post({ ...input, credit: loans.id })).status, 400);
    assert.equal((await post({ ...input, debit: cash.id, credit: loans.id })).status, 400);
    assert.equal((await post({ ...input, credit: accounts.find(account => account.type === "INCOME").id })).status, 400);
    const foreignAccount = await db("accounts").whereNot({ group_id: group.id }).first("id");
    const foreignUser = await db("users").whereNot({ group_id: group.id }).first("id");
    assert.equal((await post({ ...input, credit: foreignAccount.id })).status, 404);
    assert.equal((await post({ ...input, user_id: foreignUser.id })).status, 404);
    assert.equal((await post(input, "alpha")).status, 403);
    for (const role of ["OWNER", "ADMIN"]) {
      await db("users").where({ id: actor.id }).update({ role });
      assert.equal((await post({ ...input, amount: "1.00" })).status, 201);
    }
    await db("users").where({ id: actor.id }).update({ role: "AUDITOR" });
    assert.equal((await post()).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "TREASURER" });
    const connection = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    const concurrentHandler = serverless(createApp(connection, { getUser: async () => ({ id: authId }) }));
    try {
      const { rows: [{ pid }] } = await connection.raw("SELECT pg_backend_pid() AS pid");
      for (const change of [
        { table: "users", id: actor.id, value: { role: "AUDITOR" }, restore: { role: "TREASURER" }, status: 403 },
        { table: "accounts", id: loans.id, value: { code: "1101" }, restore: { code: "1100" }, status: 400 },
      ]) {
        const gate = await db.transaction();
        let pending;
        try {
          await gate(change.table).where({ id: change.id }).update(change.value);
          pending = concurrentHandler(event(input), {});
          await waitForLocks(gate, [pid]);
          await gate.commit();
          assert.equal((await pending).statusCode, change.status);
        } finally {
          if (!gate.isCompleted()) await gate.rollback();
          if (pending) await pending;
          await db(change.table).where({ id: change.id }).update(change.restore);
        }
      }
    } finally { await connection.destroy(); }
    const counts = async () => Promise.all(["transactions", "transaction_entries", "account_entries"].map(async table =>
      (await db(table).where({ group_id: group.id }).count("* as count").first()).count));
    const before = await counts();
    await db.raw(`CREATE FUNCTION public.reject_test_disbursement_credit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.amount < 0 AND NEW.account_id = ${cash.id} THEN RAISE EXCEPTION 'Test disbursement rejection' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_disbursement_credit_failure BEFORE INSERT ON public.account_entries
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_disbursement_credit();`);
    try {
      const failed = await post();
      assert.equal(failed.status, 409);
      assert.doesNotMatch(failed.body.error, /Test disbursement rejection/);
      assert.deepEqual(await counts(), before);
      await db.raw(`DROP TRIGGER test_disbursement_credit_failure ON public.account_entries;
        CREATE CONSTRAINT TRIGGER test_disbursement_credit_failure AFTER INSERT ON public.account_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_test_disbursement_credit();`);
      const commitFailure = await post();
      assert.equal(commitFailure.status, 409);
      assert.doesNotMatch(commitFailure.body.error, /Test disbursement rejection/);
      assert.deepEqual(await counts(), before);
    } finally {
      await db.raw("DROP TRIGGER test_disbursement_credit_failure ON public.account_entries; DROP FUNCTION public.reject_test_disbursement_credit()");
    }
  });
  await t.test("POST cycle members enrolls only group users in the current cycle", async () => {
    const [memberGroup] = await db("groups").insert({ name: "Enrollment", slug: "enrollment" }).returning("id");
    const enrollmentAuth = "99999999-9999-4999-8999-999999999999";
    await db("auth.users").insert({ id: enrollmentAuth });
    const [actor, first, second] = await db("users").insert([
      { group_id: memberGroup.id, auth_user_id: enrollmentAuth, first_name: "Enroll", family_name: "Owner", role: "OWNER" },
      { group_id: memberGroup.id, first_name: "First", family_name: "Member" },
      { group_id: memberGroup.id, first_name: "Second", family_name: "Member" },
    ]).returning("id");
    const handler = serverless(createApp(db, { getUser: async () => ({ id: enrollmentAuth }) }));
    const enroll = async users => {
      const result = await handler({ version: "2.0", rawPath: "/api/v1/cycles/members", rawQueryString: "cycle_id=999",
        headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "enrollment" },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: JSON.stringify({ users }), isBase64Encoded: false }, {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    assert.equal((await enroll([first.id])).status, 409);
    const [oldCycle] = await db("cycles").insert({ group_id: memberGroup.id, status: "closed" }).returning("id");
    assert.equal((await enroll([first.id])).status, 409);
    const [current] = await db("cycles").insert({ group_id: memberGroup.id }).returning("id");
    const foreign = await db("users").whereNot({ group_id: memberGroup.id }).first("id");
    assert.equal((await enroll([first.id, foreign.id])).status, 404);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: current.id }), []);
    const initial = await enroll([first.id, first.id]);
    assert.equal(initial.status, 200); assert.equal(initial.body.added_count, 1);
    assert.equal(initial.body.current_cycle_id, current.id);
    const saved = await db("cycle_members").where({ cycle_id: current.id, user_id: first.id }).first();
    await db("users").where({ id: actor.id }).update({ role: "ADMIN" });
    await db("cycles").where({ id: current.id }).update({ status: "active" });
    assert.equal((await enroll([first.id, second.id])).body.added_count, 1);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: current.id, user_id: first.id }).first(), saved);
    await db("cycles").where({ id: current.id }).update({ status: "distributing" });
    assert.equal((await enroll([first.id, second.id])).body.added_count, 0);
    assert.deepEqual(await db("cycle_members").where({ cycle_id: oldCycle.id }), []);
    await db("users").where({ id: actor.id }).update({ role: "MEMBER" });
    assert.equal((await enroll([actor.id])).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "OWNER" });
    await db("cycles").where({ id: current.id }).update({ status: "closed" });
    assert.equal((await enroll([actor.id])).status, 409);
    assert.equal((await db("cycle_members").where({ cycle_id: current.id })).length, 2);
  });
  await t.test("GET cycle accounts returns seeded current chart with group RLS", async () => {
    const [accountGroup] = await db("groups").insert({ name: "Account listing", slug: "account-listing" }).returning("id");
    const accountAuthId = "77777777-7777-4777-8777-777777777777";
    await db("auth.users").insert({ id: accountAuthId });
    const [actor] = await db("users").insert({ auth_user_id: accountAuthId, group_id: accountGroup.id,
      first_name: "Account", family_name: "Owner", role: "OWNER" }).returning("id");
    const handler = serverless(createApp(db, { getUser: async () => ({ id: accountAuthId }) }));
    const get = async (slug = "account-listing") => {
      const result = await handler({ version: "2.0", rawPath: "/api/v1/cycles/accounts",
        rawQueryString: `group_id=${groups[0].id}&cycle_id=999`,
        headers: { authorization: "Bearer token", "x-group-slug": slug },
        requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, accounts: [] });
    const [cycle] = await db("cycles").insert({ group_id: accountGroup.id }).returning("id");
    assert.deepEqual((await get()).body, { success: true, current_cycle_id: cycle.id, accounts: [] });
    await db("cycles").where({ id: cycle.id }).update({ status: "active" });
    const expected = JSON.parse(JSON.stringify(await db("accounts").where({ group_id: accountGroup.id, cycle_id: cycle.id }).orderBy("code").orderBy("id")));
    assert.equal(expected.length, 10);
    assert.equal(expected.some(a => a.code === "1200"), false);
    assert.equal(expected.find(a => a.code === "4300").type, "INCOME");
    for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
      await db("users").where({ id: actor.id }).update({ role });
      assert.deepEqual(await get(), { status: 200, body: { success: true, current_cycle_id: cycle.id, accounts: expected } });
    }
    assert.equal((await get("alpha")).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "MEMBER" });
    assert.equal((await get()).status, 403);
    await db("users").where({ id: actor.id }).update({ role: "OWNER" });
    await db("cycles").where({ id: cycle.id }).update({ status: "closed" });
    assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, accounts: [] });
    const [nextCycle] = await db("cycles").insert({ group_id: accountGroup.id }).returning("id");
    await db("cycles").where({ id: nextCycle.id }).update({ status: "active" });
    const next = await get();
    assert.equal(next.body.accounts.length, 10);
    assert.ok(next.body.accounts.every(a => a.cycle_id === nextCycle.id && !expected.some(old => old.id === a.id)));
    assert.deepEqual(JSON.parse(JSON.stringify(await db("accounts").where({ cycle_id: cycle.id }).orderBy("code").orderBy("id"))), expected);
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(accountGroup.id)]);
      const visible = await trx("accounts").select("id", "group_id");
      assert.equal(visible.length, 20);
      assert.ok(visible.every(a => a.group_id === accountGroup.id));
    });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      assert.deepEqual(await trx("accounts").select("id"), []);
    });
    const readMigration = require("../migrations/020_allow_cycle_accounts_read");
    await db.transaction(trx => readMigration.down(trx));
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx("accounts").select("id");
    }), { code: "42501" });
    await db.transaction(trx => readMigration.up(trx));
    assert.equal((await get()).status, 200);
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
    await db("cycles").where({ id: current.id }).update({ receipt_counter: "9007199254740993", disbursement_voucher_counter: "12" });
    for (const role of ["OWNER", "ADMIN"]) {
      await db("users").where({ id: actor.id }).update({ role });
      for (const route of ["/api/v1/cycles"]) {
        const result = await list(route);
        assert.equal(result.status, 200);
        assert.equal(result.body.current_cycle_id, current.id);
        assert.deepEqual(result.body.cycles.map(row => row.id), [current.id]);
        assert.equal(result.body.cycles.every(row => row.group_id === listGroup.id), true);
        assert.equal(result.body.cycles[0].cost_per_share, "9999999999999999.99");
        const saved = await db("cycles").where({ group_id: listGroup.id }).whereNot({ status: "closed" }).orderBy("created_at", "desc").orderBy("id", "desc");
        assert.deepEqual(result.body.cycles, JSON.parse(JSON.stringify(saved)));
        assert.equal(result.body.cycles[0].receipt_counter, "9007199254740993");
        assert.equal(result.body.cycles[0].disbursement_voucher_counter, "12");
        assert.equal(result.body.cycles[0].journal_voucher_counter, "0");
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
    await db.transaction(trx => require("../migrations/013_allow_cycle_list_columns").down(trx));
    await assert.rejects(db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx("cycles").select("cost_per_share");
    }), { code: "42501" });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL ROLE comsca_group_reader");
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(listGroup.id)]);
      assert.equal((await trx("cycles").select("id", "group_id", "created_at", "status")).length, 3);
    });
    await db.transaction(trx => require("../migrations/013_allow_cycle_list_columns").up(trx));
    assert.equal((await list()).status, 200);
  });

});
