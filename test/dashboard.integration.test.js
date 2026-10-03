const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const DashboardHandler = require("../src/handlers/dashboard");
const DonationsHandler = require("../src/handlers/donations");
const AccountingTrialBalanceHandler = require("../src/handlers/accounting-trial-balance");
const AccountingBalanceSheetHandler = require("../src/handlers/accounting-balance-sheet");
const AccountingIncomeStatementHandler = require("../src/handlers/accounting-income-statement");

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
      ["2000", "Accounts Payable", "LIABILITY"],
      ["3000", "Equity", "EQUITY"],
      ["4000", "Interest Income", "INCOME"],
      ["4100", "Unused Income", "INCOME"],
      ["4400", "Contribution Income", "INCOME"],
      ["5000", "Operating Expenses", "EXPENSE"],
      ["5100", "Unused Expenses", "EXPENSE"],
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
      occurred_at = "2026-01-01T00:00:00.000Z",
    }) {
      await db.transaction(async (trx) => {
        const [header] = await trx("transactions")
          .insert({
            group_id,
            cycle_id,
            user_id,
            type: "PAYMENT",
            amount,
            occurred_at,
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
      occurred_at: "2026-02-28T16:00:00.000Z",
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
      occurred_at: "2026-03-02T00:00:00.000Z",
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
      type: "OPERATING_EXPENSE",
      amount: "10.00",
      debit: "5000",
      credit: "2000",
      occurred_at: "2026-03-01T12:00:00.000Z",
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
    const balanceSheetHandler = new AccountingBalanceSheetHandler();
    const incomeStatementHandler = new AccountingIncomeStatementHandler();
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

    async function balanceSheetReport() {
      let body;
      await balanceSheetHandler.get(
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

    async function incomeStatementReport(query = {}) {
      let body;
      await incomeStatementHandler.get(
        {
          app: { locals: { database: db } },
          group: { id: "1" },
          authUser: { id: "actor" },
          query,
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
        ["2000", "0.00", "10.00", "0.00", "10.00"],
        ["3000", "0.00", "300.25", "0.00", "300.25"],
        ["4000", "0.00", "7.50", "0.00", "7.50"],
        ["4100", "0.00", "0.00", "0.00", "0.00"],
        ["4400", "0.00", "29.90", "0.00", "29.90"],
        ["5000", "10.00", "0.00", "10.00", "0.00"],
        ["5100", "0.00", "0.00", "0.00", "0.00"],
      ],
    );
    assert.ok(
      trialBalance.accounts.every(
        (account) => account.id && account.name && account.type,
      ),
    );
    assert.deepEqual(trialBalance.summary, {
      total_debits: "347.65",
      total_credits: "347.65",
      difference: "0.00",
    });

    const balanceSheet = await balanceSheetReport();
    assert.equal(balanceSheet.current_cycle_id, "20");
    assert.deepEqual(
      balanceSheet.assets.accounts.map((account) => [
        account.code,
        account.balance,
      ]),
      [
        ["1000", "240.28"],
        ["1100", "77.57"],
        ["1400", "19.80"],
        ["1500", "0.00"],
      ],
    );
    assert.deepEqual(balanceSheet.liabilities.accounts.map((account) => [
      account.code,
      account.balance,
    ]), [["2000", "10.00"]]);
    assert.deepEqual(balanceSheet.equity.accounts.map((account) => [
      account.code,
      account.balance,
    ]), [["3000", "300.25"]]);
    assert.deepEqual(balanceSheet.equity.current_earnings, {
      income: "37.40",
      expenses: "10.00",
      balance: "27.40",
    });
    assert.deepEqual(
      [
        balanceSheet.total_assets,
        balanceSheet.total_liabilities,
        balanceSheet.total_equity,
        balanceSheet.total_liabilities_and_equity,
        balanceSheet.difference,
      ],
      ["337.65", "10.00", "327.65", "337.65", "0.00"],
    );

    const incomeStatement = await incomeStatementReport();
    assert.equal(incomeStatement.current_cycle_id, "20");
    assert.deepEqual(
      incomeStatement.income.accounts.map(({ code, amount }) => [code, amount]),
      [
        ["4000", "7.50"],
        ["4100", "0.00"],
        ["4400", "29.90"],
      ],
    );
    assert.ok(
      incomeStatement.income.accounts.some(
        (account) => account.code === "4100" && account.amount === "0.00",
      ),
    );
    assert.deepEqual(
      incomeStatement.expenses.accounts.map(({ code, amount }) => [code, amount]),
      [["5000", "10.00"]],
    );
    assert.deepEqual(
      [incomeStatement.total_income, incomeStatement.total_expenses, incomeStatement.net_income],
      ["37.40", "10.00", "27.40"],
    );

    const dateBoundedIncomeStatement = await incomeStatementReport({
      from: "2026-03-01",
      to: "2026-03-01",
    });
    assert.deepEqual(
      dateBoundedIncomeStatement.income.accounts.map(({ code, amount }) => [code, amount]),
      [
        ["4000", "7.50"],
        ["4100", "0.00"],
        ["4400", "0.00"],
      ],
    );
    assert.deepEqual(
      dateBoundedIncomeStatement.expenses.accounts.map(({ code, amount }) => [code, amount]),
      [
        ["5000", "10.00"],
        ["5100", "0.00"],
      ],
    );
    assert.deepEqual(
      [dateBoundedIncomeStatement.total_income,
        dateBoundedIncomeStatement.total_expenses,
        dateBoundedIncomeStatement.net_income],
      ["7.50", "10.00", "-2.50"],
    );

    const fromOnlyIncomeStatement = await incomeStatementReport({
      from: "2026-03-01",
    });
    assert.deepEqual(
      [fromOnlyIncomeStatement.total_income,
        fromOnlyIncomeStatement.total_expenses,
        fromOnlyIncomeStatement.net_income],
      ["37.40", "10.00", "27.40"],
    );

    const toOnlyIncomeStatement = await incomeStatementReport({
      to: "2026-03-01",
    });
    assert.deepEqual(
      [toOnlyIncomeStatement.total_income,
        toOnlyIncomeStatement.total_expenses,
        toOnlyIncomeStatement.net_income],
      ["7.50", "10.00", "-2.50"],
    );

    const [donationIncomeAccount] = await db("accounts")
      .insert({
        group_id: 1,
        cycle_id: 20,
        code: "4300",
        name: "Donation Income",
        type: "INCOME",
      })
      .returning("id");
    const donationHandler = new DonationsHandler();
    let donationStatus;
    let donationBody;
    const beforeDonation = await db.raw("SELECT clock_timestamp() AS time");
    await donationHandler.create(
      {
        app: { locals: { database: db } },
        group: { id: "1" },
        authUser: { id: "actor" },
        body: {
          debit: String(accountId(1, 20, "1000")),
          credit: String(donationIncomeAccount.id),
          amount: "42.75",
          description: "Integration donation",
        },
      },
      {
        status(value) {
          donationStatus = value;
          return this;
        },
        json(value) {
          donationBody = value;
          return value;
        },
      },
      (error) => { throw error; },
    );
    const afterDonation = await db.raw("SELECT clock_timestamp() AS time");
    assert.equal(donationStatus, 201);
    const occurredAt = new Date(donationBody.transaction.occurred_at).getTime();
    assert.ok(occurredAt >= new Date(beforeDonation.rows[0].time).getTime());
    assert.ok(occurredAt <= new Date(afterDonation.rows[0].time).getTime());
    assert.equal(donationBody.transaction.type, "DONATION");
    assert.equal(donationBody.transaction.amount, "42.75");
    assert.equal(
      new Date(donationBody.transaction.occurred_at).toISOString(),
      new Date(donationBody.transaction.created_at).toISOString(),
    );
    assert.equal(donationBody.entries.length, 1);
    assert.deepEqual(
      donationBody.account_entries
        .map(({ account_id, amount }) => [String(account_id), amount])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        [String(accountId(1, 20, "1000")), "42.75"],
        [String(donationIncomeAccount.id), "-42.75"],
      ].sort(([left], [right]) => left.localeCompare(right)),
    );

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
    assert.deepEqual(await balanceSheetReport(), {
      success: true,
      current_cycle_id: "22",
      assets: { accounts: [], total: "0.00" },
      liabilities: { accounts: [], total: "0.00" },
      equity: {
        accounts: [],
        current_earnings: { income: "0.00", expenses: "0.00", balance: "0.00" },
        total: "0.00",
      },
      total_assets: "0.00",
      total_liabilities: "0.00",
      total_equity: "0.00",
      total_liabilities_and_equity: "0.00",
      difference: "0.00",
    });
    const emptyIncomeStatement = await incomeStatementReport();
    assert.equal(emptyIncomeStatement.current_cycle_id, "22");
    assert.deepEqual(emptyIncomeStatement.income, { accounts: [], total: "0.00" });
    assert.deepEqual(emptyIncomeStatement.expenses, { accounts: [], total: "0.00" });
    assert.deepEqual(
      [emptyIncomeStatement.total_income, emptyIncomeStatement.total_expenses,
        emptyIncomeStatement.net_income],
      ["0.00", "0.00", "0.00"],
    );

    await db("cycles").where({ id: 22 }).update({ status: "closed" });
    const noCycleIncomeStatement = await incomeStatementReport();
    assert.equal(noCycleIncomeStatement.current_cycle_id, null);
    assert.deepEqual(noCycleIncomeStatement.income, { accounts: [], total: "0.00" });
    assert.deepEqual(noCycleIncomeStatement.expenses, { accounts: [], total: "0.00" });
    assert.deepEqual(
      [noCycleIncomeStatement.total_income, noCycleIncomeStatement.total_expenses,
        noCycleIncomeStatement.net_income],
      ["0.00", "0.00", "0.00"],
    );
  },
);
