const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const DashboardHandler = require("../src/handlers/dashboard");
const AccountingTrialBalanceHandler = require("../src/handlers/accounting-trial-balance");

test(
  "dashboard calculates exact PostgreSQL totals and isolates group and cycle activity",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = knex({
      client: "pg",
      connection: process.env.TEST_DATABASE_URL,
    });
    const name = `dashboard_${process.pid}_${Date.now()}`;
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
      { id: 30, group_id: 2, status: "active", created_at: "2026-03-01" },
    ]);
    await db("users").insert([
      { id: 10, group_id: 1, auth_user_id: "actor", role: "OWNER" },
      { id: 11, group_id: 1, role: "MEMBER" },
      { id: 12, group_id: 1, role: "MEMBER" },
      { id: 30, group_id: 2, role: "MEMBER" },
    ]);
    await db("cycle_members").insert([
      { cycle_id: 20, user_id: 11 },
      { cycle_id: 20, user_id: 12 },
      { cycle_id: 21, user_id: 11 },
      { cycle_id: 30, user_id: 30 },
    ]);

    const accountCodes = [
      ["1000", "Cash", "ASSET"],
      ["1100", "Loans Receivable", "ASSET"],
      ["1400", "Contributions Receivable", "ASSET"],
      ["1500", "Unused Receivable", "ASSET"],
      ["3000", "Equity", "EQUITY"],
      ["4000", "Interest Income", "INCOME"],
      ["4400", "Contribution Income", "INCOME"],
    ];
    const accountRows = await db("accounts")
      .insert(
        [
          { group_id: 1, cycle_id: 20 },
          { group_id: 1, cycle_id: 21 },
          { group_id: 2, cycle_id: 30 },
        ].flatMap(({ group_id, cycle_id }) =>
          accountCodes.map(([code, name, type]) => ({
            group_id,
            cycle_id,
            code,
            name,
            type,
          })),
        ),
      )
      .returning("*");
    const accountId = (group_id, cycle_id, code) =>
      accountRows.find(
        (account) =>
          String(account.group_id) === String(group_id) &&
          String(account.cycle_id) === String(cycle_id) &&
          account.code === code,
      ).id;

    async function post({
      type,
      amount,
      debit,
      credit,
      group_id = 1,
      cycle_id = 20,
      user_id = 11,
    }) {
      await db.transaction(async (trx) => {
        const [header] = await trx("transactions")
          .insert({
            group_id,
            cycle_id,
            user_id,
            type: "PAYMENT",
            amount,
          })
          .returning("id");
        const [entry] = await trx("transaction_entries")
          .insert({
            group_id,
            transaction_id: header.id,
            user_id,
            cycle_id,
            type,
            amount,
          })
          .returning("id");
        await trx("account_entries").insert([
          {
            group_id,
            transaction_entry_id: entry.id,
            account_id: accountId(group_id, cycle_id, debit),
            amount,
          },
          {
            group_id,
            transaction_entry_id: entry.id,
            account_id: accountId(group_id, cycle_id, credit),
            amount: `-${amount}`,
          },
        ]);
      });
    }

    await post({
      type: "BUY_SHARE",
      amount: "300.25",
      debit: "1000",
      credit: "3000",
    });
    await post({
      type: "LOAN_DISBURSED",
      amount: "100.10",
      debit: "1100",
      credit: "1000",
    });
    await post({
      type: "LOAN_INTEREST",
      amount: "7.50",
      debit: "1100",
      credit: "4000",
    });
    await post({
      type: "LOAN_PAYMENT",
      amount: "30.03",
      debit: "1000",
      credit: "1100",
    });
    await post({
      type: "CHARGE_CONTRIBUTION",
      amount: "25.50",
      debit: "1400",
      credit: "4400",
    });
    await post({
      type: "CONTRIBUTION",
      amount: "4.40",
      debit: "1400",
      credit: "4400",
    });
    await post({
      type: "PAY_CONTRIBUTION",
      amount: "10.10",
      debit: "1000",
      credit: "1400",
    });
    await post({
      type: "BUY_SHARE",
      amount: "999.99",
      debit: "1000",
      credit: "3000",
      cycle_id: 21,
    });
    await post({
      type: "BUY_SHARE",
      amount: "555.55",
      debit: "1000",
      credit: "3000",
      group_id: 2,
      cycle_id: 30,
      user_id: 30,
    });

    const handler = new DashboardHandler();
    const trialBalanceHandler = new AccountingTrialBalanceHandler();
    async function report() {
      let body;
      await handler.get(
        {
          app: { locals: { database: db } },
          group: { id: "1" },
          authUser: { id: "actor" },
        },
        { json(value) { body = value; } },
        (error) => { throw error; },
      );
      return body;
    }

    async function trialBalanceReport() {
      let body;
      await trialBalanceHandler.get(
        {
          app: { locals: { database: db } },
          group: { id: "1" },
          authUser: { id: "actor" },
        },
        { json(value) { body = value; } },
        (error) => { throw error; },
      );
      return body;
    }

    assert.deepEqual(await report(), {
      success: true,
      current_cycle_id: "20",
      cash_on_hand: "240.28",
      outstanding_loans: "77.57",
      total_fund_value: "337.65",
      share_capital: "300.25",
      contributions_collected: "10.10",
      contributions_due: "19.80",
      active_members: 2,
    });

    const trialBalance = await trialBalanceReport();
    assert.equal(trialBalance.current_cycle_id, "20");
    assert.deepEqual(
      trialBalance.accounts.map((account) => [
        account.code,
        account.total_debits,
        account.total_credits,
        account.debit_balance,
        account.credit_balance,
      ]),
      [
        ["1000", "340.38", "100.10", "240.28", "0.00"],
        ["1100", "107.60", "30.03", "77.57", "0.00"],
        ["1400", "29.90", "10.10", "19.80", "0.00"],
        ["1500", "0.00", "0.00", "0.00", "0.00"],
        ["3000", "0.00", "300.25", "0.00", "300.25"],
        ["4000", "0.00", "7.50", "0.00", "7.50"],
        ["4400", "0.00", "29.90", "0.00", "29.90"],
      ],
    );
    assert.ok(
      trialBalance.accounts.every(
        (account) => account.id && account.name && account.type,
      ),
    );
    assert.deepEqual(trialBalance.summary, {
      total_debits: "337.65",
      total_credits: "337.65",
      difference: "0.00",
    });

    await db("cycles").where({ id: 20 }).update({ status: "closed" });
    await db("cycles").insert({
      id: 22,
      group_id: 1,
      status: "active",
      created_at: "2026-04-01",
    });
    assert.deepEqual(await report(), {
      success: true,
      current_cycle_id: "22",
      cash_on_hand: "0.00",
      outstanding_loans: "0.00",
      total_fund_value: "0.00",
      share_capital: "0.00",
      contributions_collected: "0.00",
      contributions_due: "0.00",
      active_members: 0,
    });
    assert.deepEqual(await trialBalanceReport(), {
      success: true,
      current_cycle_id: "22",
      accounts: [],
      summary: {
        total_debits: "0.00",
        total_credits: "0.00",
        difference: "0.00",
      },
    });
  },
);
