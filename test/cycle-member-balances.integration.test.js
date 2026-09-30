const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const CycleMembersHandler = require("../src/handlers/cycle-members");

test(
  "member balances aggregate actual PostgreSQL decimals and isolate membership, groups and cycles",
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    // Match the ledger integration suite: create our own database on the disposable instance.
    const admin = knex({
      client: "pg",
      connection: process.env.TEST_DATABASE_URL,
    });
    const name = `member_balances_${process.pid}_${Date.now()}`;
    let created = false;
    let db;
    t.after(async () => {
      try {
        if (db) await db.destroy();
        if (created) await admin.raw("DROP DATABASE ??", [name]);
      } finally {
        await admin.destroy();
      }
    });
    await admin.raw("CREATE DATABASE ??", [name]);
    created = true;
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    db = knex({ client: "pg", connection: url.toString() });
    // Minimal application tables plus the real ledger migrations, constraints and postings.
    await db.raw(`CREATE TABLE groups(id bigserial PRIMARY KEY);
    CREATE TABLE cycles(id bigserial PRIMARY KEY, group_id bigint REFERENCES groups(id),
      status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users(id bigserial PRIMARY KEY, group_id bigint REFERENCES groups(id),
      auth_user_id text, password text, first_name text, family_name text, username text,
      email text, phone text, address text, role text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE cycle_members(cycle_id bigint REFERENCES cycles(id), user_id bigint REFERENCES users(id),
      PRIMARY KEY(cycle_id,user_id));`);
    for (const migration of [
      "005_create_transactions",
      "006_create_accounts_and_transaction_entries",
      "018_scope_account_ledger",
      "021_validate_account_entries_after_changes",
      "027_add_contribution_member_entries",
    ]) {
      await db.transaction((trx) =>
        require(`../migrations/${migration}`).up(trx),
      );
    }
    await db("groups").insert([{ id: 1 }, { id: 2 }]);
    await db("cycles").insert([
      { id: 20, group_id: 1, status: "active", created_at: "2026-01-01" },
      { id: 21, group_id: 1, status: "closed", created_at: "2026-02-01" },
      { id: 22, group_id: 1, status: "draft", created_at: "2026-03-01" },
      { id: 30, group_id: 2, status: "active", created_at: "2026-04-01" },
    ]);
    await db("users").insert([
      {
        id: 10,
        group_id: 1,
        role: "OWNER",
        auth_user_id: "actor",
        first_name: "Owner",
        family_name: "Z",
      },
      {
        id: 11,
        group_id: 1,
        role: "MEMBER",
        auth_user_id: "secret-auth",
        password: "secret-hash",
        first_name: "Ana",
        family_name: "A",
      },
      {
        id: 12,
        group_id: 1,
        role: "MEMBER",
        first_name: "Bea",
        family_name: "A",
      },
      {
        id: 13,
        group_id: 1,
        role: "MEMBER",
        first_name: "Ana",
        family_name: "A",
      },
      {
        id: 14,
        group_id: 1,
        role: "MEMBER",
        first_name: "Historical",
        family_name: "Only",
      },
      {
        id: 15,
        group_id: 1,
        role: "MEMBER",
        first_name: "Unenrolled",
        family_name: "Only",
      },
      {
        id: 31,
        group_id: 2,
        role: "OWNER",
        auth_user_id: "other",
        first_name: "Other",
        family_name: "Group",
      },
    ]);
    await db("cycle_members").insert([
      ...[11, 12, 13].map((user_id) => ({ cycle_id: 20, user_id })),
      ...[11, 14].map((user_id) => ({ cycle_id: 21, user_id })),
      { cycle_id: 22, user_id: 11 },
      { cycle_id: 30, user_id: 31 },
    ]);
    const accounts = await db("accounts")
      .insert(
        [1, 2].flatMap((group_id) => [
          { group_id, code: "1000", name: "Cash", type: "ASSET" },
          { group_id, code: "1100", name: "Receivable", type: "ASSET" },
        ]),
      )
      .returning("*");
    async function post(
      type,
      amount,
      { group = 1, cycle = 20, headerUser = 11, entryUser = null } = {},
    ) {
      await db.transaction(async (trx) => {
        const [header] = await trx("transactions")
          .insert({
            group_id: group,
            cycle_id: cycle,
            user_id: headerUser,
            type: "PAYMENT",
            amount,
          })
          .returning("id");
        const [entry] = await trx("transaction_entries")
          .insert({
            group_id: group,
            transaction_id: header.id,
            user_id: entryUser,
            cycle_id: entryUser === null ? null : cycle,
            type,
            amount,
          })
          .returning("id");
        const pair = accounts.filter(
          (a) => String(a.group_id) === String(group),
        );
        await trx("account_entries").insert([
          {
            group_id: group,
            transaction_entry_id: entry.id,
            account_id: pair[0].id,
            amount,
          },
          {
            group_id: group,
            transaction_entry_id: entry.id,
            account_id: pair[1].id,
            amount: `-${amount}`,
          },
        ]);
      });
    }
    await post("BUY_SHARE", "9007199254740993.99");
    await post("BUY_SHARE", "0.02", { headerUser: null, entryUser: 11 });
    await post("LOAN_DISBURSED", "100.10"); // Header fallback, including null entry cycle.
    await post("LOAN_INTEREST", "7.50", { entryUser: 11 });
    await post("LOAN_PAYMENT", "30.03", { entryUser: 11 });
    await post("CHARGE_PENALTY", "10.10", { headerUser: null, entryUser: 11 });
    await post("PENALTY_PAYMENT", "3.03", { entryUser: 11 });
    await post("CHARGE_CONTRIBUTION", "25.50", {
      headerUser: null,
      entryUser: 11,
    });
    await post("CONTRIBUTION", "4.40", { headerUser: null, entryUser: 11 });
    await post("PAY_CONTRIBUTION", "10.10", { entryUser: 11 });
    await post("UNRELATED_TYPE", "500.00");
    // Entry identity wins when both are set; overpayment remains negative.
    await post("LOAN_PAYMENT", "1.01", { headerUser: 11, entryUser: 12 });
    await post("PENALTY_PAYMENT", "2.02", { headerUser: null, entryUser: 12 });
    await post("PAY_CONTRIBUTION", "3.03", { headerUser: null, entryUser: 12 });
    await post("BUY_SHARE", "999.99", { cycle: 21 });
    await post("BUY_SHARE", "999.99", { cycle: 22 });
    await post("BUY_SHARE", "999.99", { group: 2, cycle: 30, headerUser: 31 });
    await post("BUY_SHARE", "999.99", { headerUser: null }); // No member identity.
    await post("BUY_SHARE", "999.99", { cycle: null, headerUser: null });
    const handler = new CycleMembersHandler();
    async function report() {
      let body;
      await handler.list(
        {
          app: { locals: { database: db } },
          group: { id: "1" },
          authUser: { id: "actor" },
        },
        {
          json(value) {
            body = value;
          },
        },
        (error) => {
          throw error;
        },
      );
      return body;
    }
    const result = await report();
    assert.equal(result.current_cycle_id, "20");
    assert.deepEqual(
      result.members.map((m) => m.id),
      ["11", "13", "12"],
    );
    const balances = (member) => [
      member.total_shares,
      member.remaining_loan,
      member.unpaid_penalties,
      member.unpaid_contributions,
    ];
    assert.deepEqual(balances(result.members[0]), [
      "9007199254740994.01",
      "77.57",
      "7.07",
      "19.80",
    ]);
    assert.deepEqual(balances(result.members[1]), [
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
    assert.deepEqual(balances(result.members[2]), [
      "0.00",
      "-1.01",
      "-2.02",
      "-3.03",
    ]);
    assert.deepEqual(
      Object.keys(result.members[0]).sort(),
      [
        "id",
        "group_id",
        "first_name",
        "family_name",
        "username",
        "email",
        "phone",
        "address",
        "role",
        "created_at",
        "updated_at",
        "total_shares",
        "remaining_loan",
        "unpaid_penalties",
        "unpaid_contributions",
      ].sort(),
    );
    await db("cycles").where({ id: 20 }).update({ status: "distributing" });
    assert.deepEqual(await report(), result);
    await db("cycles").where({ id: 20 }).update({ status: "closed" });
    assert.deepEqual(await report(), {
      success: true,
      current_cycle_id: null,
      members: [],
    });
    await db("cycles").where({ id: 22 }).update({ status: "closed" });
    assert.deepEqual(await report(), {
      success: true,
      current_cycle_id: null,
      members: [],
    });
  },
);
